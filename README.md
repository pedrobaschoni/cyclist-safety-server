# CyclistSafe — Servidor 2.3

Servidor intermediário do CyclistSafe: recebe as quedas do ESP32, guarda tudo
no PostgreSQL (Neon), conta o tempo para o ciclista responder e envia SMS aos
contatos de emergência. Também manda notificação push (Firebase) para o
celular do ciclista, que chega mesmo com o app fechado.

O app do ciclista entra com **e-mail e senha**: o servidor devolve um **JWT**
e todas as rotas do app exigem esse token. A senha é guardada com **bcrypt**.

## Como funciona o alerta

1. O ESP32 detecta a queda → `POST /api/quedas` → status **PRE_ALERTA**
2. O app mostra a contagem regressiva. "Estou bem" → **CANCELADO**, ninguém é avisado
3. O tempo acabou sem resposta → SMS para todos os contatos → **ALERTA_ENVIADO**
4. Sem confirmação, reenvia um lembrete a cada 2 minutos (3 envios no total)
5. O familiar abre o link do SMS e toca em "Vi o alerta" → **CONFIRMADO**
6. Se o ciclista tocar "Estou bem" depois do envio, os contatos recebem
   "está tudo bem" → **CANCELADO**

Quem conta o tempo é o **servidor**. O alerta sai mesmo se o app estiver
fechado. Se o servidor reiniciar no meio de uma contagem, ele retoma de onde
parou ao ligar.

## Publicar no Render

### 1. Atualize o repositório

Substitua o conteúdo do repositório `cyclist-safety-server` pelos arquivos
desta pasta (`src/`, `package.json`, `package-lock.json`, `tsconfig.json`,
`.gitignore`, `README.md`). Apague o `src/database.ts` antigo se ainda existir.

```
git add -A
git commit -m "Servidor 2.3: login com JWT"
git push
```

### 2. Configure as variáveis de ambiente

Render → seu serviço → **Environment** → **Add Environment Variable**:

| Variável | Obrigatória | Valor |
|---|---|---|
| `DATABASE_URL` | **Sim** | Endereço de conexão do Neon (`postgresql://...`) |
| `JWT_SECRET` | **Sim** | Chave que assina os tokens de login (mínimo 32 caracteres; use o botão **Generate** do Render) |
| `TWILIO_ACCOUNT_SID` | Não | Account SID do Twilio (começa com `AC`) |
| `TWILIO_AUTH_TOKEN` | Não | Auth Token do Twilio |
| `TWILIO_FROM` | Não | Número do Twilio no formato `+1...` |
| `REENVIO_SEGUNDOS` | Não | Intervalo entre lembretes (padrão: 120) |
| `MAX_TENTATIVAS` | Não | Total de envios, contando o primeiro (padrão: 3) |
| `FIREBASE_SERVICE_ACCOUNT` | Não | Conteúdo **inteiro** do `.json` da conta de serviço do Firebase (push) |

**Sem as variáveis do Twilio o servidor funciona em modo simulado:** os SMS
aparecem nos logs do Render e ficam registrados no banco com status `SIMULADO`.

**Sem `FIREBASE_SERVICE_ACCOUNT` o push fica desativado** e o app só recebe
alertas enquanto estiver aberto (WebSocket). Nunca coloque esse `.json` no
GitHub: ele dá acesso total ao projeto Firebase.

O servidor precisa de **Node 22 ou mais novo** (o `package.json` já pede isso
e o Render respeita).

Build e start continuam os mesmos:
- Build Command: `npm install && npm run build`
- Start Command: `npm start`

### 3. Confira

Abra `https://SEU-SERVIDOR.onrender.com/api/health`. Deve aparecer
`"banco": "conectado"`, `"sms": "simulado"` (ou `"twilio"`) e
`"push": "firebase"` (ou `"desativado"`) e `"jwt": "configurado"`.

Depois abra o app no celular: ele envia seus contatos para o servidor
automaticamente ao conectar.

## Segurança (login com JWT)

| Quem | Como se identifica |
|---|---|
| App do ciclista | `Authorization: Bearer <jwt>` (validade de 7 dias) |
| WebSocket | `wss://.../ws?token=<jwt>` — conexão sem token é recusada |
| ESP32 | Rotas `/api/quedas` e `/api/event` continuam abertas (proteção da placa: trabalho futuro) |
| Familiar | Link `/c/:token` — o próprio link é o segredo |

- **Primeiro acesso:** `POST /api/auth/cadastro` cria a conta. Só é permitido
  enquanto não existir nenhuma conta (o protótipo atende um ciclista).
- **Depois:** `POST /api/auth/login` devolve o JWT.
- **Força bruta:** 10 senhas erradas seguidas bloqueiam o IP por 15 minutos.
- **Sem `JWT_SECRET`:** o servidor usa uma chave temporária e o app precisa
  entrar de novo a cada reinício.

## Rotas

Rotas marcadas com 🔒 exigem o JWT.

| Método | Rota | Quem usa | Função |
|---|---|---|---|
| GET | `/api/health` | App / você | Status do servidor, banco, SMS, push e login |
| GET | `/api/auth/status` | App | Já existe conta? `{ temConta }` |
| POST | `/api/auth/cadastro` | App | Primeiro acesso `{ nome, email, senha }` → JWT |
| POST | `/api/auth/login` | App | `{ email, senha }` → JWT |
| GET | `/api/auth/eu` 🔒 | App | Dados da conta |
| POST | `/api/quedas` | ESP32 | Queda detectada `{ magnitude, lat, lng, deviceId }` |
| POST | `/api/event` | ESP32 | Heartbeat `{ tipo, magnitude, deviceId }` |
| GET | `/api/eventos` 🔒 | App | Histórico de quedas |
| GET | `/api/eventos/:id` 🔒 | App | Uma queda |
| GET | `/api/eventos/:id/envios` 🔒 | Você | Registro de SMS enviados daquela queda |
| POST | `/api/eventos/:id/cancelar` 🔒 | App | "Estou bem" |
| POST | `/api/eventos/:id/enviar-agora` 🔒 | App | "Preciso de ajuda" |
| GET / PUT | `/api/config` 🔒 | App | Nome, tempo para cancelar e contatos |
| POST | `/api/push/registrar` 🔒 | App | Registra o celular para push `{ token }` |
| POST | `/api/push/remover` 🔒 | App | Ao sair da conta, para de receber push |
| GET | `/api/dispositivos` 🔒 | App | Último status do ESP32 |
| GET / POST | `/c/:token` | Familiar | Página do link do SMS |
| WS | `/ws` | App | Eventos em tempo real |

## Banco de dados (tabelas criadas automaticamente)

- `configuracao`: nome do ciclista e tempo para cancelar
- `contatos`: nome, telefone (+55...), parentesco, principal
- `quedas`: impacto, localização, status e horário de cada etapa
- `links_confirmacao`: um link por contato em cada alerta
- `envios_sms`: cada SMS enviado (tipo, status, erro)
- `tokens_push`: celulares registrados para notificação push
- `usuarios`: conta do ciclista (e-mail e hash bcrypt da senha)

## Rodar no computador

```
npm install
set DATABASE_URL=postgresql://...   (PowerShell: $env:DATABASE_URL="postgresql://...")
npm run dev
```
