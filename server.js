// ============================================================
//  4A Loja — Backend Mercado Livre
//  Hospede no Render: https://render.com
// ============================================================

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── CONFIGURAÇÕES ────────────────────────────────────────────
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI     = process.env.REDIRECT_URI;
const PORT             = process.env.PORT || 3000;

// ── TOKEN (em memória) ───────────────────────────────────────
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
  if (tokenData.expires_at && agora < tokenData.expires_at - 60_000) return;

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

// Calcula data de despacho em dias úteis
function calcDataDespacho(dataBase, diasUteis) {
  const dt = new Date(dataBase);
  let dias = 0;
  while (dias < diasUteis) {
    dt.setDate(dt.getDate() + 1);
    if (dt.getDay() !== 0 && dt.getDay() !== 6) dias++;
  }
  return dt.toLocaleDateString('pt-BR');
}

// ── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────

app.get('/auth/ml', (req, res) => {
  const url =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${ML_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  res.redirect(url);
});

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
    res.status(500).send('❌ Erro: ' + (e.response?.data?.message || e.message));
  }
});

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

    const pedidos = await Promise.all((resp.data.results || []).map(async p => {
      // Buscar detalhes do envio para pegar data limite de despacho
      let dataDespacho = null;
      let dataDespachoTs = null;

      try {
        if (p.shipping?.id) {
          const shipResp = await api.get(`/shipments/${p.shipping.id}`);
          const ship = shipResp.data;

          // Tenta pegar a data limite de handling do envio
          if (ship.shipping_option?.estimated_handling_limit?.date) {
            const d = new Date(ship.shipping_option.estimated_handling_limit.date);
            dataDespacho = d.toLocaleDateString('pt-BR');
            dataDespachoTs = d.getTime();
          } else if (ship.lead_time?.handling?.unit === 'hour') {
            // handling em horas
            const horas = ship.lead_time.handling.value || 24;
            const dt = new Date(new Date(p.date_created).getTime() + horas * 3600000);
            dataDespacho = dt.toLocaleDateString('pt-BR');
            dataDespachoTs = dt.getTime();
          } else if (ship.lead_time?.handling?.value) {
            // handling em dias
            dataDespacho = calcDataDespacho(p.date_created, ship.lead_time.handling.value);
            dataDespachoTs = new Date(dataDespacho.split('/').reverse().join('-')).getTime();
          }
        }
      } catch(e) {
        console.log('Erro ao buscar envio:', e.message);
      }

      // Fallback: 3 dias úteis
      if (!dataDespacho) {
        dataDespacho = calcDataDespacho(p.date_created, 3);
        dataDespachoTs = new Date(p.date_created).getTime() + 3 * 86400000;
      }

      return {
        id:             p.id,
        status:         p.status,
        data:           new Date(p.date_created).toLocaleDateString('pt-BR'),
        dataTs:         new Date(p.date_created).getTime(),
        total:          p.total_amount,
        itens:          p.order_items.map(i => ({
          titulo:       i.item.title,
          sku:          i.item.seller_sku || '',
          quantidade:   i.quantity,
          preco:        i.unit_price,
        })),
        comprador:      p.buyer?.nickname || '',
        envio_id:       p.shipping?.id || null,
        data_despacho:  dataDespacho,
        dataDespachoTs,
      };
    }));

    res.json({ total: resp.data.paging?.total || 0, pedidos });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ erro: e.message });
  }
});

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

app.get('/anuncios', async (req, res) => {
  try {
    await refreshTokenSeNecessario();
    const api    = mlApi();
    const limite = parseInt(req.query.limite) || 50;

    const idsResp = await api.get(`/users/${tokenData.user_id}/items/search`, {
      params: { limit: limite },
    });
    const ids = idsResp.data.results || [];
    if (!ids.length) return res.json([]);

    const chunks = [];
    for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));

    const anuncios = [];
    for (const chunk of chunks) {
      const r = await api.get('/items', { params: { ids: chunk.join(',') } });
      r.data.forEach(item => {
        if (item.code === 200) {
          const b = item.body;
          anuncios.push({
            id:         b.id,
            titulo:     b.title,
            sku:        b.seller_sku || '',
            preco:      b.price,
            quantidade: b.available_quantity,
            status:     b.status,
            permalink:  b.permalink,
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
  res.json({ status: 'ok', app: '4A Loja — ML Backend', versao: '2.0.0' });
});

app.listen(PORT, () => console.log(`🚀 Backend rodando na porta ${PORT}`));
