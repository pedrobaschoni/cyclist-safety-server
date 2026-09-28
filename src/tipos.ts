// ─────────────────────────────────────────────────────────────
//  Tipos do servidor CyclistSafe
// ─────────────────────────────────────────────────────────────

/**
 * Ciclo de vida de uma queda:
 *
 *   PRE_ALERTA ──("Estou bem" no app)──────────────► CANCELADO
 *       │
 *       └─(prazo esgota ou "Preciso de ajuda")─► ALERTA_ENVIADO ──(familiar confirma)──► CONFIRMADO
 *                                                    │                                     │
 *                                                    └──────("Estou bem" no app)───────────┴──► CANCELADO
 */
export type StatusQueda = "PRE_ALERTA" | "ALERTA_ENVIADO" | "CONFIRMADO" | "CANCELADO";

/** Linha da tabela `quedas`. */
export interface QuedaRow {
  id: string;
  device_id: string;
  magnitude: number;
  latitude: number;
  longitude: number;
  status: StatusQueda;
  detectada_em: Date;
  prazo_alerta: Date;
  alerta_enviado_em: Date | null;
  cancelado_em: Date | null;
  confirmado_em: Date | null;
  confirmado_por: string | null;
  contatos_avisados: number;
  tentativas_envio: number;
}

/** Linha da tabela `contatos`. */
export interface ContatoRow {
  id: string;
  nome: string;
  telefone: string; // formato internacional: +5518999999999
  parentesco: string;
  principal: boolean;
  ordem: number;
}

export interface Configuracao {
  nomeCiclista: string;
  tempoPreAlerta: number; // segundos
}

/** Queda no formato que o app Flutter espera. */
export interface QuedaApi {
  id: string;
  deviceId: string;
  magnitude: number;
  latitude: number;
  longitude: number;
  timestampServidor: string;
  status: StatusQueda;
  prazoAlerta: string;
  alertaEnviadoEm: string | null;
  canceladoEm: string | null;
  confirmadoEm: string | null;
  confirmadoPor: string | null;
  contatosAvisados: number;
  tentativasEnvio: number;
  googleMapsUrl: string;
}

/** Último status recebido do ESP32 (heartbeat). Fica só em memória. */
export interface StatusDispositivo {
  deviceId: string;
  ultimaConexao: string;
  estadoFSM: string;
  ultimaMagnitude: number;
  online: boolean;
}

export type TipoMensagemWS = "QUEDA" | "ATUALIZACAO_QUEDA" | "STATUS" | "PONG" | "BOAS_VINDAS";

export interface MensagemWS {
  tipo: TipoMensagemWS;
  payload: unknown;
}

export interface ApiResposta<T = unknown> {
  sucesso: boolean;
  dados?: T;
  erro?: string;
  timestamp: string;
}
