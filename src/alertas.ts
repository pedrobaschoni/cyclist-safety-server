/**
 * Lógica do alerta de queda.
 *
 * Quem conta o tempo e envia os SMS é o SERVIDOR (não o celular). Assim o
 * alerta sai mesmo que o app esteja fechado ou o celular sem bateria.
 *
 *  1. ESP32 detecta a queda → registrarQueda() → status PRE_ALERTA
 *  2. O app mostra a contagem regressiva; "Estou bem" → cancelar()
 *  3. Prazo esgotado → dispararAlerta(): SMS para todos os contatos
 *  4. Enquanto ninguém confirmar, reenvia a cada REENVIO_SEGUNDOS
 *     (até MAX_TENTATIVAS envios no total)
 *  5. Familiar abre o link do SMS e confirma → confirmarPorLink()
 *  6. Se o ciclista tocar "Estou bem" depois do envio, os contatos
 *     recebem um SMS avisando que está tudo bem
 */

import { randomBytes, randomUUID } from "crypto";
import {
  buscarLinkConfirmacao,
  buscarQueda,
  criarLinkConfirmacao,
  db,
  inserirQueda,
  lerConfiguracao,
  listarContatos,
  quedaParaApi,
  quedasEmAndamento,
  registrarEnvio,
  urlMapa,
} from "./db";
import { enviarPush } from "./push";
import { enviarSms } from "./sms";
import { ContatoRow, QuedaRow } from "./tipos";
import { transmitir } from "./websocket";

const REENVIO_SEGUNDOS = Number(process.env.REENVIO_SEGUNDOS ?? 120);
const MAX_TENTATIVAS = Number(process.env.MAX_TENTATIVAS ?? 3);

/** Timers ativos (contagem regressiva ou próximo reenvio), por queda. */
const timers = new Map<string, NodeJS.Timeout>();

function agendar(quedaId: string, emMs: number, acao: () => Promise<void>): void {
  cancelarTimer(quedaId);
  const t = setTimeout(() => {
    timers.delete(quedaId);
    acao().catch((e) => console.error(`[Alerta] Erro na queda ${quedaId}:`, e));
  }, Math.max(0, emMs));
  timers.set(quedaId, t);
}

function cancelarTimer(quedaId: string): void {
  const t = timers.get(quedaId);
  if (t) clearTimeout(t);
  timers.delete(quedaId);
}

function publicarAtualizacao(q: QuedaRow): void {
  transmitir("ATUALIZACAO_QUEDA", quedaParaApi(q));
}

// ─────────────────────────────────────────
//  Endereço público (para o link do SMS)
// ─────────────────────────────────────────

function urlPublica(): string {
  const url =
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL || // o Render define essa variável sozinho
    `http://localhost:${process.env.PORT ?? 3000}`;
  return url.replace(/\/$/, "");
}

function horaBrasil(data: Date): string {
  return new Date(data).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatarG(g: number): string {
  return `${Number(g).toFixed(2).replace(".", ",")} g`;
}

// ─────────────────────────────────────────
//  1. Nova queda
// ─────────────────────────────────────────

export async function registrarQueda(dados: {
  deviceId: string;
  magnitude: number;
  latitude: number;
  longitude: number;
}): Promise<QuedaRow> {
  const { tempoPreAlerta } = await lerConfiguracao();
  const prazo = new Date(Date.now() + tempoPreAlerta * 1000);

  const q = await inserirQueda({ id: randomUUID(), ...dados, prazo });
  transmitir("QUEDA", quedaParaApi(q));
  void enviarPush(
    "⚠️ Possível queda detectada",
    `Toque para responder. Seus contatos serão avisados em ${tempoPreAlerta} s se você não disser que está bem.`,
    { quedaId: q.id, tipo: "QUEDA" }
  );
  agendar(q.id, prazo.getTime() - Date.now(), () => dispararAlerta(q.id).then(() => undefined));

  console.log(
    `[Alerta] Queda ${q.id} | ${formatarG(q.magnitude)} | ` +
      `contatos serão avisados em ${tempoPreAlerta}s se não houver resposta`
  );
  return q;
}

// ─────────────────────────────────────────
//  3. Envio do alerta
// ─────────────────────────────────────────

export async function dispararAlerta(quedaId: string): Promise<QuedaRow | null> {
  // UPDATE com condição de status: se o ciclista cancelou no mesmo instante,
  // nada acontece (evita enviar SMS de uma queda já cancelada).
  const { rows } = await db().query<QuedaRow>(
    `UPDATE quedas
        SET status = 'ALERTA_ENVIADO', alerta_enviado_em = now(), prazo_alerta = LEAST(prazo_alerta, now())
      WHERE id = $1 AND status = 'PRE_ALERTA'
      RETURNING *`,
    [quedaId]
  );
  const q = rows[0];
  if (!q) return null;

  const [config, contatos] = await Promise.all([lerConfiguracao(), listarContatos()]);
  const nome = config.nomeCiclista || "O ciclista";

  if (contatos.length === 0) {
    console.warn(`[Alerta] Queda ${quedaId}: NENHUM contato cadastrado — ninguém foi avisado`);
  }

  for (const c of contatos) {
    const token = randomBytes(6).toString("base64url");
    await criarLinkConfirmacao(token, q.id, c.nome);
    const texto =
      `CyclistSafe: ${nome} pode ter sofrido uma queda de bicicleta ` +
      `(${formatarG(q.magnitude)}) as ${horaBrasil(q.detectada_em)}. ` +
      `Local: ${urlMapa(q.latitude, q.longitude)} ` +
      `Confirme que viu: ${urlPublica()}/c/${token}`;
    await enviarParaContato(q.id, c, "ALERTA", texto);
  }

  const { rows: atualizadas } = await db().query<QuedaRow>(
    `UPDATE quedas SET contatos_avisados = $2, tentativas_envio = 1
      WHERE id = $1 RETURNING *`,
    [q.id, contatos.length]
  );
  const final = atualizadas[0];
  publicarAtualizacao(final);
  void enviarPush(
    "Seus contatos foram avisados",
    contatos.length > 0
      ? `Enviamos sua localização para ${contatos.length} contato(s). Se estiver tudo bem, toque aqui e avise.`
      : "Nenhum contato cadastrado — ninguém foi avisado. Cadastre contatos no app.",
    { quedaId: q.id, tipo: "ALERTA_ENVIADO" }
  );
  console.log(`[Alerta] Queda ${quedaId}: alerta enviado para ${contatos.length} contato(s)`);

  if (contatos.length > 0 && MAX_TENTATIVAS > 1) {
    agendar(q.id, REENVIO_SEGUNDOS * 1000, () => reenviarAlerta(q.id));
  }
  return final;
}

// ─────────────────────────────────────────
//  4. Reenvio enquanto ninguém confirma
// ─────────────────────────────────────────

async function reenviarAlerta(quedaId: string): Promise<void> {
  const { rows } = await db().query<QuedaRow>(
    `UPDATE quedas SET tentativas_envio = tentativas_envio + 1
      WHERE id = $1 AND status = 'ALERTA_ENVIADO' AND tentativas_envio < $2
      RETURNING *`,
    [quedaId, MAX_TENTATIVAS]
  );
  const q = rows[0];
  if (!q) return; // já confirmado, cancelado ou atingiu o limite

  const [config, contatos] = await Promise.all([lerConfiguracao(), listarContatos()]);
  const nome = config.nomeCiclista || "O ciclista";

  for (const c of contatos) {
    const token = randomBytes(6).toString("base64url");
    await criarLinkConfirmacao(token, q.id, c.nome);
    const texto =
      `LEMBRETE CyclistSafe (${q.tentativas_envio}/${MAX_TENTATIVAS}): ` +
      `${nome} ainda nao respondeu depois da queda. ` +
      `Local: ${urlMapa(q.latitude, q.longitude)} ` +
      `Confirme que viu: ${urlPublica()}/c/${token}`;
    await enviarParaContato(q.id, c, "LEMBRETE", texto);
  }

  publicarAtualizacao(q);
  console.log(`[Alerta] Queda ${quedaId}: lembrete ${q.tentativas_envio}/${MAX_TENTATIVAS}`);

  if (q.tentativas_envio < MAX_TENTATIVAS) {
    agendar(q.id, REENVIO_SEGUNDOS * 1000, () => reenviarAlerta(q.id));
  }
}

async function enviarParaContato(
  quedaId: string,
  contato: ContatoRow,
  tipo: string,
  texto: string
): Promise<void> {
  const r = await enviarSms(contato.telefone, texto);
  await registrarEnvio({
    quedaId,
    contatoNome: contato.nome,
    telefone: contato.telefone,
    tipo,
    status: r.status,
    erro: r.erro,
  });
}

// ─────────────────────────────────────────
//  2 e 6. "Estou bem"
// ─────────────────────────────────────────

export async function cancelar(quedaId: string): Promise<QuedaRow | null> {
  const { rows } = await db().query<QuedaRow>(
    `UPDATE quedas SET status = 'CANCELADO', cancelado_em = now()
      WHERE id = $1 AND status <> 'CANCELADO'
      RETURNING *`,
    [quedaId]
  );
  const q = rows[0];
  if (!q) return buscarQueda(quedaId); // já estava cancelada (ou não existe)

  cancelarTimer(quedaId);
  publicarAtualizacao(q);

  if (q.alerta_enviado_em) {
    // Os contatos já tinham sido avisados: mandamos a boa notícia.
    const [config, contatos] = await Promise.all([lerConfiguracao(), listarContatos()]);
    const nome = config.nomeCiclista || "O ciclista";
    for (const c of contatos) {
      await enviarParaContato(
        q.id,
        c,
        "ESTOU_BEM",
        `CyclistSafe: ${nome} informou que esta bem. Pode desconsiderar o alerta de queda.`
      );
    }
    console.log(`[Alerta] Queda ${quedaId}: ciclista está bem — contatos avisados`);
  } else {
    console.log(`[Alerta] Queda ${quedaId}: cancelada a tempo, ninguém foi avisado`);
  }
  return q;
}

// ─────────────────────────────────────────
//  "Preciso de ajuda": envia sem esperar
// ─────────────────────────────────────────

export async function enviarAgora(quedaId: string): Promise<QuedaRow | null> {
  cancelarTimer(quedaId);
  const enviada = await dispararAlerta(quedaId);
  return enviada ?? buscarQueda(quedaId);
}

// ─────────────────────────────────────────
//  5. Familiar confirma pelo link
// ─────────────────────────────────────────

export async function confirmarPorLink(
  token: string
): Promise<{ queda: QuedaRow; contatoNome: string; jaConfirmada: boolean } | null> {
  const link = await buscarLinkConfirmacao(token);
  if (!link) return null;

  const { rows } = await db().query<QuedaRow>(
    `UPDATE quedas SET status = 'CONFIRMADO', confirmado_em = now(), confirmado_por = $2
      WHERE id = $1 AND status = 'ALERTA_ENVIADO'
      RETURNING *`,
    [link.quedaId, link.contatoNome]
  );

  if (rows[0]) {
    cancelarTimer(link.quedaId); // para os lembretes
    publicarAtualizacao(rows[0]);
    void enviarPush(
      `${link.contatoNome} viu seu alerta`,
      "Seu contato de emergência confirmou que recebeu a mensagem.",
      { quedaId: link.quedaId, tipo: "CONFIRMADO" }
    );
    console.log(`[Alerta] Queda ${link.quedaId}: confirmada por ${link.contatoNome}`);
    return { queda: rows[0], contatoNome: link.contatoNome, jaConfirmada: false };
  }

  const q = await buscarQueda(link.quedaId);
  return q ? { queda: q, contatoNome: link.contatoNome, jaConfirmada: true } : null;
}

// ─────────────────────────────────────────
//  Ao ligar o servidor: retoma o que estava em andamento
// ─────────────────────────────────────────

export async function retomarAlertasPendentes(): Promise<void> {
  const pendentes = await quedasEmAndamento();
  for (const q of pendentes) {
    if (q.status === "PRE_ALERTA") {
      const faltam = new Date(q.prazo_alerta).getTime() - Date.now();
      agendar(q.id, faltam, () => dispararAlerta(q.id).then(() => undefined));
    } else if (q.status === "ALERTA_ENVIADO" && q.tentativas_envio < MAX_TENTATIVAS) {
      agendar(q.id, REENVIO_SEGUNDOS * 1000, () => reenviarAlerta(q.id));
    }
  }
  if (pendentes.length > 0) {
    console.log(`[Alerta] ${pendentes.length} alerta(s) em andamento retomado(s)`);
  }
}

/** Para os testes: cancela todos os timers. */
export function pararTodosOsTimers(): void {
  for (const id of [...timers.keys()]) cancelarTimer(id);
}
