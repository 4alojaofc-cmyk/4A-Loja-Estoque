// ============================================================
//  4A Loja — Backend Mercado Livre
//  Hospede no Railway: https://railway.app
// ============================================================

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // permite o HTML local chamar o backend

// ── CONFIGURAÇÕES ────────────────────────────────────────────
// Coloque estas variáveis no painel do Railway → Variables
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI     = process.env.REDIRECT_URI;
const PORT             = process.env.PORT             || 3000;

// ── TOKEN (em memória — use Redis ou banco em produção) ──────
let tokenData = {
  access_token:  null,
  refresh_token: null,
  expires_at:    null,
  user_id:       null,
};

// ── HELPERS ──────────────────────────────────────────────────
async function refreshTokenSeNecessario() {
  if (!tokenData.refresh_token) throw new Error('Não autenticado. Acesse /auth/ml primeiro.');
  const agora = Date.now();
  if (tokenData.expires_at && agora < tokenData.expires_at - 60_000) return; // ainda válido

  const res = await axios.post('https://api.mercadolibre.com/oauth/token', {
    grant_type:    'refresh_token',
    client_id:     ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: tokenData.refresh_token,
  });
  salvarToken(res.data);
}

function salvarToken(data) {
  tokenData.access_token  = data.access_token;
  tokenData.refresh_token = data.refresh_token;
  tokenData.user_id       = data.user_id;
  tokenData.expires_at    = Date.now() + data.expires_in * 1000;
  console.log('✅ Token ML salvo. User ID:', tokenData.user_id);
}

function mlApi() {
  return axios.create({
    baseURL: 'https://api.mercadolibre.com',
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
}

// ── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────

// 1) Redireciona para o login do Mercado Livre
app.get('/auth/ml', (req, res) => {
  const url =
    `https://auth.mercadolibre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${ML_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

// 2) ML retorna aqui após o login do usuário
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('❌ Code não recebido.');

  try {
    const resp = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type:    'authorization_code',
      client_id:     ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri:  REDIRECT_URI,
    });
    salvarToken(resp.data);
    res.send(`
      <h2 style="font-family:sans-serif;color:green">✅ Mercado Livre conectado!</h2>
      <p style="font-family:sans-serif">Pode fechar esta aba e voltar para o sistema 4A Loja.</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    `);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('❌ Erro ao trocar o code pelo token: ' + (e.response?.data?.message || e.message));
  }
});

// 3) Status da conexão
app.get('/status', (req, res) => {
  res.json({
    conectado: !!tokenData.access_token,
    user_id:   tokenData.user_id,
    expira_em: tokenData.expires_at
      ? new Date(tokenData.expires_at).toLocaleString('pt-BR')
      : null,
  });
});

// ── ROTAS DE PEDIDOS ──────────────────────────────────────────

// 4) Lista pedidos recentes (padrão: últimos 30 dias, até 50)
app.get('/pedidos', async (req, res) => {
  try {
    await refreshTokenSeNecessario();
    const api    = mlApi();
    const limite = parseInt(req.query.limite) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const resp = await api.get(`/orders/search`, {
      params: {
        seller: tokenData.user_id,
        sort:   'date_desc',
        limit:  limite,
        offset,
      },
    });

    const pedidos = (resp.data.results || []).map(p => ({
      id:          p.id,
      status:      p.status,
      data:        new Date(p.date_created).toLocaleDateString('pt-BR'),
      total:       p.total_amount,
      itens:       p.order_items.map(i => ({
        titulo:    i.item.title,
        sku:       i.item.seller_sku || '',
        quantidade: i.quantity,
        preco:     i.unit_price,
      })),
      comprador:   p.buyer?.nickname || '',
      envio_id:    p.shipping?.id || null,
    }));

    res.json({ total: resp.data.paging?.total || 0, pedidos });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ erro: e.message });
  }
});

// 5) Detalhe de um pedido específico
app.get('/pedidos/:id', async (req, res) => {
  try {
    await refreshTokenSeNecessario();
    const resp = await mlApi().get(`/orders/${req.params.id}`);
    res.json(resp.data);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── ROTAS DE ANÚNCIOS / ESTOQUE ───────────────────────────────

// 6) Lista anúncios ativos do vendedor
app.get('/anuncios', async (req, res) => {
  try {
    await refreshTokenSeNecessario();
    const api    = mlApi();
    const limite = parseInt(req.query.limite) || 50;

    // Busca os IDs dos anúncios
    const idsResp = await api.get(`/users/${tokenData.user_id}/items/search`, {
      params: { limit: limite },
    });
    const ids = idsResp.data.results || [];
    if (!ids.length) return res.json([]);

    // Busca detalhes em lote (máx 20 por vez)
    const chunks = [];
    for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

    const anuncios = [];
    for (const chunk of chunks) {
      const r = await api.get('/items', { params: { ids: chunk.join(',') } });
      r.data.forEach(item => {
        if (item.code === 200) {
          const b = item.body;
          anuncios.push({
            id:          b.id,
            titulo:      b.title,
            sku:         b.seller_sku || '',
            preco:       b.price,
            quantidade:  b.available_quantity,
            status:      b.status,
            permalink:   b.permalink,
          });
        }
      });
    }
    res.json(anuncios);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ erro: e.message });
  }
});

// 7) Atualiza o estoque de um anúncio no ML
app.patch('/anuncios/:itemId/estoque', async (req, res) => {
  const { quantidade } = req.body;
  if (quantidade === undefined) return res.status(400).json({ erro: 'Informe "quantidade".' });

  try {
    await refreshTokenSeNecessario();
    const resp = await mlApi().put(`/items/${req.params.itemId}`, {
      available_quantity: quantidade,
    });
    res.json({ ok: true, quantidade_atualizada: resp.data.available_quantity });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ erro: e.response?.data?.message || e.message });
  }
});

// ── ROTA DE SAÚDE ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: '4A Loja — ML Backend', versao: '1.0.0' });
});

app.listen(PORT, () => console.log(`🚀 Backend rodando na porta ${PORT}`));
