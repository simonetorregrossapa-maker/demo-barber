import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL")!;
const ORE_ATTESA = 3;

function romeOffsetMs(d: Date): number {
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const rome = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  return rome.getTime() - utc.getTime();
}

function appuntamentoUTC(data: string, orario: string): number {
  const [y, m, dd] = data.split("-").map(Number);
  const [hh, mi] = orario.replace(".", ":").split(":").map(Number);
  const naive = Date.UTC(y, m - 1, dd, hh, mi || 0);
  return naive - romeOffsetMs(new Date(naive));
}

function emailHtml(nome: string, attivita: string, linkGoogle: string, linkFeedback: string): string {
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#222">
    <p>Ciao ${nome},</p>
    <p>grazie per essere passato da <b>${attivita}</b> oggi! 💈</p>
    <p>Com'è andata? Ci basta un tocco:</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${linkGoogle}" style="display:inline-block;background:#1a7f37;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-size:16px;margin:4px">
        👍 Tutto benissimo
      </a>
      <a href="${linkFeedback}" style="display:inline-block;background:#eee;color:#333;text-decoration:none;padding:14px 22px;border-radius:10px;font-size:16px;margin:4px">
        👎 Qualcosa non è andato
      </a>
    </p>
    <p style="font-size:13px;color:#888">A presto,<br>${attivita}</p>
  </div>`;
}

Deno.serve(async () => {
  const { data: settings } = await supabase.from("settings").select("key,value");
  const get = (k: string) => settings?.find((s: any) => s.key === k)?.value ?? "";
  const placeId = get("google_place_id");
  const attivita = get("nome_attivita") || "la nostra barberia";
  const mittente = get("email_mittente") || "Barberia <onboarding@resend.dev>";
  const linkGoogle = `https://search.google.com/local/writereview?placeid=${placeId}`;

  const dueGiorniFa = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { data: prenotazioni, error } = await supabase
    .from("prenotazioni")
    .select("*")
    .eq("consenso", true)
    .eq("recensione_inviata", false)
    .neq("stato", "cancellata")
    .gte("data", dueGiorniFa);

  if (error) return new Response(JSON.stringify({ error }), { status: 500 });

  const ora = Date.now();
  let inviate = 0;

  for (const p of prenotazioni ?? []) {
    const appMs = appuntamentoUTC(p.data, p.orario);
    if (Number.isNaN(appMs)) continue;
    const trascorse = ora - appMs;
    if (trascorse < ORE_ATTESA * 3600000) continue;
    if (trascorse > 2 * 86400000) continue;

    const linkFeedback = `${SITE_URL}/feedback.html?id=${p.id}`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: mittente,
        to: p.email,
        subject: `Com'è andata da ${attivita}?`,
        html: emailHtml(p.nome, attivita, linkGoogle, linkFeedback),
      }),
    });

    if (r.ok) {
      await supabase.from("prenotazioni").update({ recensione_inviata: true }).eq("id", p.id);
      inviate++;
    }
  }

  return new Response(JSON.stringify({ inviate }), {
    headers: { "Content-Type": "application/json" },
  });
});
