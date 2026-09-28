/**
 * Página que o familiar abre pelo link do SMS.
 * Mostra onde foi a queda e tem o botão "Vi o alerta".
 */

import { urlMapa } from "./db";
import { QuedaRow } from "./tipos";

function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function horaBrasil(data: Date): string {
  return new Date(data).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function layout(
  titulo: string,
  cor: string,
  conteudo: string,
  acompanhar?: { token: string; status: string }
): string {
  // Consulta o status a cada 5 s; se mudou (ex.: ciclista disse que está bem),
  // recarrega a página para mostrar a situação nova.
  const script = acompanhar
    ? `<script>
  (function () {
    var atual = ${JSON.stringify(acompanhar.status)};
    var url = "/c/" + ${JSON.stringify(encodeURIComponent(acompanhar.token))} + "/estado";
    setInterval(function () {
      fetch(url, { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.dados && j.dados.status && j.dados.status !== atual) location.reload();
        })
        .catch(function () {});
    }, 5000);
  })();
</script>`
    : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)} — CyclistSafe</title>
<style>
  :root { --cor: ${cor}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: #0b1120; color: #f1f5f9; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 20px; }
  .cartao { width: 100%; max-width: 420px; background: #131b2e; border: 1px solid #232d45;
            border-radius: 24px; overflow: hidden; }
  .topo { background: var(--cor); padding: 28px 24px; }
  .marca { font-size: 13px; font-weight: 800; letter-spacing: 1.5px; opacity: .85; }
  h1 { margin: 10px 0 0; font-size: 26px; line-height: 1.2; }
  .corpo { padding: 22px 24px 26px; }
  .linha { display: flex; justify-content: space-between; padding: 10px 0;
           border-bottom: 1px solid #232d45; font-size: 15px; }
  .linha span:first-child { color: #94a3b8; }
  .linha span:last-child { font-weight: 700; }
  p { color: #cbd5e1; line-height: 1.5; }
  .botao { display: block; width: 100%; text-align: center; text-decoration: none;
           border: 0; border-radius: 16px; padding: 17px; font-size: 17px; font-weight: 800;
           cursor: pointer; margin-top: 14px; font-family: inherit; }
  .principal { background: #10b981; color: #fff; }
  .secundario { background: #1e293b; color: #f1f5f9; border: 1px solid #334155; }
  .aviso { font-size: 13px; color: #94a3b8; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
  <div class="cartao">${conteudo}</div>
  ${script}
</body>
</html>`;
}

export function paginaLinkInvalido(): string {
  return layout(
    "Link inválido",
    "#475569",
    `<div class="topo"><div class="marca">CYCLISTSAFE</div><h1>Link inválido ou expirado</h1></div>
     <div class="corpo"><p>Este link de confirmação não foi encontrado.</p></div>`
  );
}

export function paginaConfirmacao(
  q: QuedaRow,
  contatoNome: string,
  nomeCiclista: string,
  token: string,
  acabouDeConfirmar = false
): string {
  const nome = escapar(nomeCiclista || "O ciclista");
  const acompanhar = { token, status: q.status };
  const mapa = urlMapa(q.latitude, q.longitude);
  const detalhes = `
    <div class="linha"><span>Horário</span><span>${horaBrasil(q.detectada_em)}</span></div>
    <div class="linha"><span>Força do impacto</span><span>${Number(q.magnitude).toFixed(2).replace(".", ",")} g</span></div>
    <a class="botao secundario" href="${mapa}" target="_blank" rel="noopener">📍 Ver localização no mapa</a>`;

  if (q.status === "CANCELADO") {
    return layout(
      "Está tudo bem",
      "#047857",
      `<div class="topo"><div class="marca">CYCLISTSAFE</div><h1>${nome} está bem 🎉</h1></div>
       <div class="corpo">
         <p>${nome} informou pelo aplicativo que está bem${q.alerta_enviado_em ? " e que foi um alarme falso" : ""}. Não é preciso fazer nada.</p>
         ${detalhes}
       </div>`,
      acompanhar
    );
  }

  if (q.status === "CONFIRMADO") {
    const quem = escapar(q.confirmado_por ?? "Um contato");
    const texto = acabouDeConfirmar
      ? `Obrigado, ${escapar(contatoNome)}! ${nome} foi avisado(a) no aplicativo que você viu o alerta.`
      : `${quem} já confirmou que viu este alerta.`;
    return layout(
      "Alerta confirmado",
      "#1d4ed8",
      `<div class="topo"><div class="marca">CYCLISTSAFE</div><h1>Alerta confirmado ✔</h1></div>
       <div class="corpo">
         <p>${texto} Se não conseguir contato, vá até a localização abaixo ou ligue 192 (SAMU).</p>
         ${detalhes}
       </div>`,
      acompanhar
    );
  }

  // ALERTA_ENVIADO (ou PRE_ALERTA, caso raro)
  return layout(
    "Possível queda",
    "#dc2626",
    `<div class="topo"><div class="marca">CYCLISTSAFE • ALERTA</div>
       <h1>${nome} pode ter sofrido uma queda</h1></div>
     <div class="corpo">
       <p>Olá, ${escapar(contatoNome)}. O sensor da bicicleta detectou um impacto forte e
          ${nome} não respondeu ao aplicativo.</p>
       ${detalhes}
       <form method="post" action="/c/${encodeURIComponent(token)}">
         <button class="botao principal" type="submit">✔ Vi o alerta, estou verificando</button>
       </form>
       <div class="aviso">Em caso de emergência, ligue 192 (SAMU).</div>
     </div>`,
    acompanhar
  );
}
