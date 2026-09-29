/**
 * Autenticação do app do ciclista: senha com bcrypt + token JWT.
 *
 * Fluxo:
 *   1. O app faz login (e-mail + senha) → o servidor confere o hash bcrypt
 *   2. O servidor devolve um JWT assinado com JWT_SECRET (validade: 7 dias)
 *   3. O app manda "Authorization: Bearer <token>" em toda requisição
 *   4. O middleware exigirLogin confere a assinatura e a validade
 *
 * Rotas do ESP32 e o link do familiar continuam sem login.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const VALIDADE_TOKEN = "7d";
const CUSTO_BCRYPT = 10;

let segredo: string | null = null;

/** Chave que assina os tokens. Vem da variável de ambiente JWT_SECRET. */
function chaveSecreta(): string {
  if (segredo) return segredo;
  const env = process.env.JWT_SECRET;
  if (env && env.length >= 32) {
    segredo = env;
  } else {
    // Sem JWT_SECRET o servidor funciona, mas todo reinício desloga o app.
    segredo = randomBytes(48).toString("hex");
    console.warn(
      "[Auth] JWT_SECRET ausente ou curta (mínimo 32 caracteres) — usando chave temporária. " +
        "Configure JWT_SECRET no Render para o login não cair a cada reinício."
    );
  }
  return segredo;
}

export function jwtConfigurado(): boolean {
  const env = process.env.JWT_SECRET;
  return !!env && env.length >= 32;
}

export function gerarHashSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, CUSTO_BCRYPT);
}

export function conferirSenha(senha: string, hash: string): Promise<boolean> {
  return bcrypt.compare(senha, hash);
}

export interface DadosToken {
  id: number;
  email: string;
}

export function gerarToken(usuario: DadosToken): string {
  return jwt.sign({ email: usuario.email }, chaveSecreta(), {
    subject: String(usuario.id),
    expiresIn: VALIDADE_TOKEN,
    algorithm: "HS256",
  });
}

/** Retorna os dados do token, ou null se for inválido/vencido. */
export function validarToken(token: string): DadosToken | null {
  try {
    const p = jwt.verify(token, chaveSecreta(), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    const id = Number(p.sub);
    if (!Number.isInteger(id) || typeof p.email !== "string") return null;
    return { id, email: p.email };
  } catch {
    return null;
  }
}

/** Pega o token do cabeçalho "Authorization: Bearer <token>". */
export function tokenDaRequisicao(req: Request): string | null {
  const h = req.headers.authorization ?? "";
  const [tipo, token] = h.split(" ");
  return tipo === "Bearer" && token ? token : null;
}

/** Middleware: só deixa passar quem mandou um JWT válido. */
export function exigirLogin(req: Request, res: Response, next: NextFunction): void {
  const token = tokenDaRequisicao(req);
  const dados = token ? validarToken(token) : null;
  if (!dados) {
    res.status(401).json({
      sucesso: false,
      erro: "Não autorizado — faça login novamente",
      timestamp: new Date().toISOString(),
    });
    return;
  }
  res.locals.usuario = dados;
  next();
}

// ─────────────────────────────────────────
//  Limite de tentativas de login (contra força bruta)
// ─────────────────────────────────────────

const JANELA_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 10;
const tentativas = new Map<string, { quantidade: number; desde: number }>();

/** true se este IP já errou demais nos últimos 15 minutos. */
export function bloqueadoPorTentativas(ip: string): boolean {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() - t.desde > JANELA_MS) {
    tentativas.delete(ip);
    return false;
  }
  return t.quantidade >= MAX_TENTATIVAS;
}

export function registrarFalhaLogin(ip: string): void {
  const t = tentativas.get(ip);
  if (!t || Date.now() - t.desde > JANELA_MS) {
    tentativas.set(ip, { quantidade: 1, desde: Date.now() });
  } else {
    t.quantidade++;
  }
}

export function limparFalhasLogin(ip: string): void {
  tentativas.delete(ip);
}
