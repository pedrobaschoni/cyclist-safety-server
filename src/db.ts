/**
 * Banco de dados PostgreSQL (Neon).
 *
 * As tabelas são criadas automaticamente na primeira vez que o servidor liga.
 */

import { Pool, PoolClient } from "pg";
import { Configuracao, ContatoRow, QuedaApi, QuedaRow } from "./tipos";

let pool: Pool | null = null;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS configuracao (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nome_ciclista    TEXT NOT NULL DEFAULT '',
  tempo_pre_alerta INT  NOT NULL DEFAULT 30,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO configuracao (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS contatos (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  telefone    TEXT NOT NULL,
  parentesco  TEXT NOT NULL DEFAULT 'Outro',
  principal   BOOLEAN NOT NULL DEFAULT false,
  ordem       INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quedas (
  id                 UUID PRIMARY KEY,
  device_id          TEXT NOT NULL,
  magnitude          DOUBLE PRECISION NOT NULL,
  latitude           DOUBLE PRECISION NOT NULL,
  longitude          DOUBLE PRECISION NOT NULL,
  status             TEXT NOT NULL,
  detectada_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  prazo_alerta       TIMESTAMPTZ NOT NULL,
  alerta_enviado_em  TIMESTAMPTZ,
  cancelado_em       TIMESTAMPTZ,
  confirmado_em      TIMESTAMPTZ,
  confirmado_por     TEXT,
  contatos_avisados  INT NOT NULL DEFAULT 0,
  tentativas_envio   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quedas_detectada ON quedas (detectada_em DESC);
CREATE INDEX IF NOT EXISTS idx_quedas_status ON quedas (status);

CREATE TABLE IF NOT EXISTS links_confirmacao (
  token         TEXT PRIMARY KEY,
  queda_id      UUID NOT NULL REFERENCES quedas(id) ON DELETE CASCADE,
  contato_nome  TEXT NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS envios_sms (
  id            SERIAL PRIMARY KEY,
  queda_id      UUID NOT NULL REFERENCES quedas(id) ON DELETE CASCADE,
  contato_nome  TEXT NOT NULL,
  telefone      TEXT NOT NULL,
  tipo          TEXT NOT NULL,
  status        TEXT NOT NULL,
  erro          TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_envios_queda ON envios_sms (queda_id);

CREATE TABLE IF NOT EXISTS tokens_push (
  token          TEXT PRIMARY KEY,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * O endereço que o Neon fornece vem com `sslmode=require&channel_binding=require`.
 * Removemos esses parâmetros da URL e ativamos o SSL diretamente no driver.
 */
function prepararConexao(url: string) {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  const semSsl = u.searchParams.get("sslmode") === "disable";
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  return {
    connectionString: u.toString(),
    ssl: local || semSsl ? undefined : { rejectUnauthorized: true },
  };
}

/** Permite usar outro pool (ex.: testes). */
export function configurarPool(p: Pool): void {
  pool = p;
}

export function db(): Pool {
  if (!pool) throw new Error("Banco de dados não inicializado");
  return pool;
}

export async function iniciarBanco(): Promise<void> {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL não configurada. Cole o endereço de conexão do Neon " +
          "nas variáveis de ambiente do Render (Environment → DATABASE_URL)."
      );
    }
    pool = new Pool({
      ...prepararConexao(url),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
    });
    pool.on("error", (e) => console.error("[DB] Erro no pool:", e.message));
  }
  await pool.query(ESQUEMA);
  console.log("[DB] PostgreSQL conectado e tabelas prontas");
}

export async function encerrarBanco(): Promise<void> {
  await pool?.end();
  pool = null;
}

// ─────────────────────────────────────────
//  Conversões
// ─────────────────────────────────────────

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function urlMapa(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export function quedaParaApi(r: QuedaRow): QuedaApi {
  return {
    id: r.id,
    deviceId: r.device_id,
    magnitude: Number(r.magnitude),
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    timestampServidor: new Date(r.detectada_em).toISOString(),
    status: r.status,
    prazoAlerta: new Date(r.prazo_alerta).toISOString(),
    alertaEnviadoEm: iso(r.alerta_enviado_em),
    canceladoEm: iso(r.cancelado_em),
    confirmadoEm: iso(r.confirmado_em),
    confirmadoPor: r.confirmado_por,
    contatosAvisados: r.contatos_avisados,
    tentativasEnvio: r.tentativas_envio,
    googleMapsUrl: urlMapa(Number(r.latitude), Number(r.longitude)),
  };
}

// ─────────────────────────────────────────
//  Configuração e contatos
// ─────────────────────────────────────────

export async function lerConfiguracao(): Promise<Configuracao> {
  const { rows } = await db().query(
    "SELECT nome_ciclista, tempo_pre_alerta FROM configuracao WHERE id = 1"
  );
  return {
    nomeCiclista: rows[0]?.nome_ciclista ?? "",
    tempoPreAlerta: rows[0]?.tempo_pre_alerta ?? 30,
  };
}

export async function listarContatos(): Promise<ContatoRow[]> {
  const { rows } = await db().query<ContatoRow>(
    "SELECT * FROM contatos ORDER BY principal DESC, ordem ASC, nome ASC"
  );
  return rows;
}

/** Substitui a configuração e a lista de contatos de uma vez (transação). */
export async function salvarConfiguracao(
  config: Configuracao,
  contatos: Omit<ContatoRow, "ordem">[]
): Promise<void> {
  const cliente: PoolClient = await db().connect();
  try {
    await cliente.query("BEGIN");
    await cliente.query(
      `UPDATE configuracao
          SET nome_ciclista = $1, tempo_pre_alerta = $2, atualizado_em = now()
        WHERE id = 1`,
      [config.nomeCiclista, config.tempoPreAlerta]
    );
    await cliente.query("DELETE FROM contatos");
    for (let i = 0; i < contatos.length; i++) {
      const c = contatos[i];
      await cliente.query(
        `INSERT INTO contatos (id, nome, telefone, parentesco, principal, ordem)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.id, c.nome, c.telefone, c.parentesco, c.principal, i]
      );
    }
    await cliente.query("COMMIT");
  } catch (e) {
    await cliente.query("ROLLBACK");
    throw e;
  } finally {
    cliente.release();
  }
}

// ─────────────────────────────────────────
//  Quedas
// ─────────────────────────────────────────

export async function inserirQueda(q: {
  id: string;
  deviceId: string;
  magnitude: number;
  latitude: number;
  longitude: number;
  prazo: Date;
}): Promise<QuedaRow> {
  const { rows } = await db().query<QuedaRow>(
    `INSERT INTO quedas (id, device_id, magnitude, latitude, longitude, status, prazo_alerta)
     VALUES ($1, $2, $3, $4, $5, 'PRE_ALERTA', $6)
     RETURNING *`,
    [q.id, q.deviceId, q.magnitude, q.latitude, q.longitude, q.prazo]
  );
  return rows[0];
}

export async function buscarQueda(id: string): Promise<QuedaRow | null> {
  const { rows } = await db().query<QuedaRow>("SELECT * FROM quedas WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listarQuedas(limite: number): Promise<QuedaRow[]> {
  const { rows } = await db().query<QuedaRow>(
    "SELECT * FROM quedas ORDER BY detectada_em DESC LIMIT $1",
    [limite]
  );
  return rows;
}

export async function quedasEmAndamento(): Promise<QuedaRow[]> {
  const { rows } = await db().query<QuedaRow>(
    "SELECT * FROM quedas WHERE status IN ('PRE_ALERTA', 'ALERTA_ENVIADO')"
  );
  return rows;
}

// ─────────────────────────────────────────
//  SMS e links de confirmação
// ─────────────────────────────────────────

export async function registrarEnvio(e: {
  quedaId: string;
  contatoNome: string;
  telefone: string;
  tipo: string;
  status: string;
  erro?: string;
}): Promise<void> {
  await db().query(
    `INSERT INTO envios_sms (queda_id, contato_nome, telefone, tipo, status, erro)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.quedaId, e.contatoNome, e.telefone, e.tipo, e.status, e.erro ?? null]
  );
}

export async function listarEnvios(quedaId: string) {
  const { rows } = await db().query(
    `SELECT contato_nome AS "contatoNome", telefone, tipo, status, erro, criado_em AS "enviadoEm"
       FROM envios_sms WHERE queda_id = $1 ORDER BY criado_em ASC, id ASC`,
    [quedaId]
  );
  return rows;
}

export async function criarLinkConfirmacao(
  token: string,
  quedaId: string,
  contatoNome: string
): Promise<void> {
  await db().query(
    "INSERT INTO links_confirmacao (token, queda_id, contato_nome) VALUES ($1, $2, $3)",
    [token, quedaId, contatoNome]
  );
}

export async function buscarLinkConfirmacao(
  token: string
): Promise<{ quedaId: string; contatoNome: string } | null> {
  const { rows } = await db().query(
    `SELECT queda_id AS "quedaId", contato_nome AS "contatoNome"
       FROM links_confirmacao WHERE token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

// ─────────────────────────────────────────
//  Celulares para notificação push (Firebase)
// ─────────────────────────────────────────

export async function salvarTokenPush(token: string): Promise<void> {
  await db().query(
    `INSERT INTO tokens_push (token) VALUES ($1)
     ON CONFLICT (token) DO UPDATE SET atualizado_em = now()`,
    [token]
  );
}

export async function listarTokensPush(): Promise<string[]> {
  const { rows } = await db().query<{ token: string }>(
    "SELECT token FROM tokens_push ORDER BY atualizado_em DESC LIMIT 20"
  );
  return rows.map((r) => r.token);
}

export async function removerTokensPush(tokens: string[]): Promise<void> {
  await db().query("DELETE FROM tokens_push WHERE token = ANY($1)", [tokens]);
}
