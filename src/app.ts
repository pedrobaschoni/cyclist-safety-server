/**
 * Rotas HTTP do servidor CyclistSafe.
 */

import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import {
  cancelar,
  confirmarPorLink,
  enviarAgora,
  registrarQueda,
} from "./alertas";
import {
  bloqueadoPorTentativas,
  conferirSenha,
  exigirLogin,
  gerarHashSenha,
  gerarToken,
  jwtConfigurado,
  limparFalhasLogin,
  registrarFalhaLogin,
} from "./auth";
import {
  buscarLinkConfirmacao,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  contarUsuarios,
  criarPrimeiroUsuario,
  buscarQueda,
  lerConfiguracao,
  listarContatos,
  listarEnvios,
  listarQuedas,
  quedaParaApi,
  salvarConfiguracao,
  removerTokensPush,
  salvarTokenPush,
} from "./db";
import { pushConfigurado } from "./push";
import { paginaConfirmacao, paginaLinkInvalido } from "./paginas";
import { smsConfigurado } from "./sms";
import { ApiResposta, StatusDispositivo } from "./tipos";
import { clientesConectados, transmitir } from "./websocket";

// Último status de cada ESP32 (heartbeat). Não precisa ir para o banco.
const dispositivos = new Map<string, StatusDispositivo>();

export function ultimosStatusDispositivos(): StatusDispositivo[] {
  return [...dispositivos.values()];
}

function ok<T>(dados: T): ApiResposta<T> {
  return { sucesso: true, dados, timestamp: new Date().toISOString() };
}

function erro(res: Response, status: number, mensagem: string) {
  return res.status(status).json({
    sucesso: false,
    erro: mensagem,
    timestamp: new Date().toISOString(),
  } satisfies ApiResposta);
}

/** Envolve rotas assíncronas: qualquer exceção vira resposta 500. */
function rota(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizarEmail(valor: unknown): string {
  return String(valor ?? "").trim().toLowerCase();
}

/** Hash de uma senha qualquer, usado só para igualar o tempo de resposta do login. */
const HASH_FALSO = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.3gTBZ2QsUnOa1JrQ2bl3yXfGJY2i";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idDaRota(req: Request): string | null {
  const id = String(req.params.id ?? "");
  return UUID.test(id) ? id : null;
}

function numero(valor: unknown, padrao = 0): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
}

/** Normaliza para o formato internacional: +55 + DDD + número. */
function telefoneInternacional(tel: string): string {
  const d = String(tel).replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) return `+${d}`;
  return `+55${d}`;
}

export function criarApp() {
  const app = express();
  app.set("trust proxy", 1); // o Render fica na frente (IP real vem no X-Forwarded-For)
  app.use(cors({ origin: "*" }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    if (req.path !== "/api/event") console.log(`[HTTP] ${req.method} ${req.path}`);
    next();
  });

  // ── Página inicial / saúde ─────────────────────────────────
  app.get("/", (_req, res) => {
    res.json(
      ok({
        servico: "CyclistSafe — servidor intermediário",
        versao: "2.3.0",
        documentacao: "Veja README.md",
      })
    );
  });

  app.get(
    "/api/health",
    rota(async (_req, res) => {
      const config = await lerConfiguracao(); // também testa o banco
      res.json(
        ok({
          status: "ok",
          versao: "2.3.0",
          banco: "conectado",
          sms: smsConfigurado() ? "twilio" : "simulado",
          push: pushConfigurado() ? "firebase" : "desativado",
          jwt: jwtConfigurado() ? "configurado" : "chave temporária",
          nomeCiclista: config.nomeCiclista,
          clientesWs: clientesConectados(),
          uptime: process.uptime(),
        })
      );
    })
  );

  // ── ESP32: queda detectada ─────────────────────────────────
  // Formato do firmware: { magnitude, lat, lng, deviceId }
  app.post(
    "/api/quedas",
    rota(async (req, res) => {
      const b = req.body ?? {};
      if (b.magnitude === undefined) return erro(res, 400, "Campo obrigatório: magnitude");

      const q = await registrarQueda({
        deviceId: String(b.deviceId ?? "ESP32_CICLISTA_01"),
        magnitude: numero(b.magnitude),
        latitude: numero(b.latitude ?? b.lat),
        longitude: numero(b.longitude ?? b.lng),
      });
      res.status(201).json(ok(quedaParaApi(q)));
    })
  );

  // ── ESP32: heartbeat (e compatibilidade com a versão antiga) ─
  app.post(
    "/api/event",
    rota(async (req, res) => {
      const b = req.body ?? {};
      if (!b.deviceId || !b.tipo) {
        return erro(res, 400, "Campos obrigatórios: deviceId, tipo");
      }

      if (b.tipo === "QUEDA_CONFIRMADA") {
        const q = await registrarQueda({
          deviceId: String(b.deviceId),
          magnitude: numero(b.magnitude),
          latitude: numero(b.latitude ?? b.lat),
          longitude: numero(b.longitude ?? b.lng),
        });
        return res.status(201).json(ok(quedaParaApi(q)));
      }

      const status: StatusDispositivo = {
        deviceId: String(b.deviceId),
        ultimaConexao: new Date().toISOString(),
        estadoFSM: String(b.tipo),
        ultimaMagnitude: numero(b.magnitude),
        online: true,
      };
      dispositivos.set(status.deviceId, status);
      transmitir("STATUS", status);
      res.json(ok({ recebido: true }));
    })
  );

  // ── Login do app (JWT) ─────────────────────────────────────
  // O app pergunta se já existe conta para mostrar "Criar conta" ou "Entrar"
  app.get(
    "/api/auth/status",
    rota(async (_req, res) => {
      res.json(ok({ temConta: (await contarUsuarios()) > 0 }));
    })
  );

  // Primeiro acesso: cria a conta (só é permitido se ainda não existir nenhuma)
  app.post(
    "/api/auth/cadastro",
    rota(async (req, res) => {
      const nome = String(req.body?.nome ?? "").trim();
      const email = normalizarEmail(req.body?.email);
      const senha = String(req.body?.senha ?? "");
      if (nome.length < 2 || nome.length > 60) return erro(res, 400, "Informe seu nome");
      if (!EMAIL.test(email)) return erro(res, 400, "E-mail inválido");
      if (senha.length < 6 || senha.length > 72) {
        return erro(res, 400, "A senha deve ter entre 6 e 72 caracteres");
      }

      const usuario = await criarPrimeiroUsuario(nome, email, await gerarHashSenha(senha));
      if (!usuario) return erro(res, 409, "Já existe uma conta cadastrada. Faça login.");

      console.log(`[Auth] Conta criada: ${email}`);
      res.status(201).json(
        ok({ token: gerarToken(usuario), usuario: { nome: usuario.nome, email: usuario.email } })
      );
    })
  );

  app.post(
    "/api/auth/login",
    rota(async (req, res) => {
      const ip = req.ip ?? "desconhecido";
      if (bloqueadoPorTentativas(ip)) {
        return erro(res, 429, "Muitas tentativas. Aguarde 15 minutos e tente de novo.");
      }
      const email = normalizarEmail(req.body?.email);
      const senha = String(req.body?.senha ?? "");
      const usuario = EMAIL.test(email) ? await buscarUsuarioPorEmail(email) : null;

      // Confere a senha mesmo sem usuário, para o tempo de resposta não revelar
      // se o e-mail existe ou não
      const senhaCorreta = await conferirSenha(senha, usuario?.senha_hash ?? HASH_FALSO);
      if (!usuario || !senhaCorreta) {
        registrarFalhaLogin(ip);
        return erro(res, 401, "E-mail ou senha incorretos");
      }

      limparFalhasLogin(ip);
      console.log(`[Auth] Login: ${email}`);
      res.json(
        ok({ token: gerarToken(usuario), usuario: { nome: usuario.nome, email: usuario.email } })
      );
    })
  );

  // ── A partir daqui, as rotas do app exigem login ───────────
  app.use(["/api/eventos", "/api/config", "/api/push", "/api/dispositivos", "/api/auth/eu"], exigirLogin);

  app.get(
    "/api/auth/eu",
    rota(async (_req, res) => {
      const u = await buscarUsuarioPorId(res.locals.usuario.id);
      if (!u) return erro(res, 401, "Conta não encontrada — faça login novamente");
      res.json(ok({ nome: u.nome, email: u.email }));
    })
  );

  // ── App: histórico ─────────────────────────────────────────
  app.get(
    "/api/eventos",
    rota(async (req, res) => {
      const limite = Math.min(Math.max(numero(req.query.limite, 50), 1), 200);
      const eventos = (await listarQuedas(limite)).map(quedaParaApi);
      res.json(ok({ eventos, total: eventos.length }));
    })
  );

  app.get(
    "/api/eventos/:id",
    rota(async (req, res) => {
      const id = idDaRota(req);
      const q = id ? await buscarQueda(id) : null;
      if (!q) return erro(res, 404, "Queda não encontrada");
      res.json(ok(quedaParaApi(q)));
    })
  );

  // Registro dos SMS de uma queda (para auditoria / TCC)
  app.get(
    "/api/eventos/:id/envios",
    rota(async (req, res) => {
      const id = idDaRota(req);
      if (!id || !(await buscarQueda(id))) return erro(res, 404, "Queda não encontrada");
      res.json(ok({ envios: await listarEnvios(id) }));
    })
  );

  // ── App: "Estou bem" ───────────────────────────────────────
  app.post(
    "/api/eventos/:id/cancelar",
    rota(async (req, res) => {
      const id = idDaRota(req);
      const q = id ? await cancelar(id) : null;
      if (!q) return erro(res, 404, "Queda não encontrada");
      res.json(ok(quedaParaApi(q)));
    })
  );

  // ── App: "Preciso de ajuda — avisar agora" ─────────────────
  app.post(
    "/api/eventos/:id/enviar-agora",
    rota(async (req, res) => {
      const id = idDaRota(req);
      const q = id ? await enviarAgora(id) : null;
      if (!q) return erro(res, 404, "Queda não encontrada");
      res.json(ok(quedaParaApi(q)));
    })
  );

  // ── App: nome, tempo de cancelamento e contatos ────────────
  app.get(
    "/api/config",
    rota(async (_req, res) => {
      const [config, contatos] = await Promise.all([lerConfiguracao(), listarContatos()]);
      res.json(ok({ ...config, contatos }));
    })
  );

  app.put(
    "/api/config",
    rota(async (req, res) => {
      const b = req.body ?? {};
      const tempo = Math.round(numero(b.tempoPreAlerta, 30));
      if (tempo < 5 || tempo > 300) {
        return erro(res, 400, "tempoPreAlerta deve estar entre 5 e 300 segundos");
      }
      const lista: unknown[] = Array.isArray(b.contatos) ? b.contatos : [];
      if (lista.length > 10) return erro(res, 400, "Máximo de 10 contatos");

      const contatos = lista
        .map((item, i) => {
          const c = (item ?? {}) as Record<string, unknown>;
          return {
            id: String(c.id ?? `contato-${i}`),
            nome: String(c.nome ?? "").trim(),
            telefone: telefoneInternacional(String(c.telefone ?? "")),
            parentesco: String(c.parentesco ?? "Outro"),
            principal: c.principal === true,
          };
        })
        .filter((c) => c.nome.length > 0 && c.telefone.length >= 12);

      await salvarConfiguracao(
        { nomeCiclista: String(b.nomeCiclista ?? "").trim(), tempoPreAlerta: tempo },
        contatos
      );
      console.log(`[Config] Salva: ${contatos.length} contato(s), cancelamento em ${tempo}s`);
      res.json(ok({ contatos: contatos.length, tempoPreAlerta: tempo }));
    })
  );

  // ── App: registra o celular para receber notificações push ─
  app.post(
    "/api/push/registrar",
    rota(async (req, res) => {
      const token = String(req.body?.token ?? "").trim();
      if (token.length < 20 || token.length > 4096) return erro(res, 400, "Token inválido");
      await salvarTokenPush(token);
      res.json(ok({ registrado: true }));
    })
  );

  // Ao sair da conta, o celular para de receber notificações
  app.post(
    "/api/push/remover",
    rota(async (req, res) => {
      const token = String(req.body?.token ?? "").trim();
      if (token) await removerTokensPush([token]);
      res.json(ok({ removido: true }));
    })
  );

  // ── Dispositivos (ESP32) ───────────────────────────────────
  app.get("/api/dispositivos", (_req, res) => {
    const lista = ultimosStatusDispositivos();
    res.json(ok({ dispositivos: lista, total: lista.length }));
  });

  // ── Link do SMS para o familiar ────────────────────────────
  // GET mostra a página (não confirma sozinho: pré-visualizações de link
  // do WhatsApp/SMS abririam o link e confirmariam sem ninguém ver).
  app.get(
    "/c/:token",
    rota(async (req, res) => {
      const token = String(req.params.token);
      const link = await buscarLinkConfirmacao(token);
      const q = link ? await buscarQueda(link.quedaId) : null;
      if (!link || !q) return res.status(404).type("html").send(paginaLinkInvalido());
      const config = await lerConfiguracao();
      // ?ok=1 → acabou de confirmar (veio do redirecionamento do POST)
      const acabouDeConfirmar =
        req.query.ok === "1" && q.status === "CONFIRMADO" && q.confirmado_por === link.contatoNome;
      res
        .type("html")
        .send(paginaConfirmacao(q, link.contatoNome, config.nomeCiclista, token, acabouDeConfirmar));
    })
  );

  // Status atual — a página do familiar consulta a cada 5 s e se atualiza sozinha
  app.get(
    "/c/:token/estado",
    rota(async (req, res) => {
      const link = await buscarLinkConfirmacao(String(req.params.token));
      const q = link ? await buscarQueda(link.quedaId) : null;
      if (!q) return erro(res, 404, "Link não encontrado");
      res.set("Cache-Control", "no-store").json(ok({ status: q.status }));
    })
  );

  app.post(
    "/c/:token",
    rota(async (req, res) => {
      const token = String(req.params.token);
      const r = await confirmarPorLink(token);
      if (!r) return res.status(404).type("html").send(paginaLinkInvalido());
      // Redireciona para o GET: assim recarregar a página não reenvia o formulário
      res.redirect(303, `/c/${encodeURIComponent(token)}${r.jaConfirmada ? "" : "?ok=1"}`);
    })
  );

  // ── Erros ──────────────────────────────────────────────────
  app.use((_req, res) => erro(res, 404, "Rota não encontrada"));
  app.use((e: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[HTTP] Erro:", e);
    erro(res, 500, "Erro interno do servidor");
  });

  return app;
}
