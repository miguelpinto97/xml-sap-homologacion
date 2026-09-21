const serverless = require('serverless-http');
const { app, initializeDatabase } = require('../../server');

// serverless-http 3.x + Express 5: el stream del body puede llegar vacio a
// express.json(). Pre-parseamos event.body aqui y lo dejamos en req para que
// server.js lo use como respaldo.
function parseEventBody(event) {
  const raw = event.body;
  if (raw == null || raw === '') return undefined;
  try {
    const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const handler = serverless(app, {
  request(req, event) {
    const preparsed = parseEventBody(event);
    if (preparsed !== undefined) req._preparsedBody = preparsed;
  },
});
let initialization;

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    initialization ||= initializeDatabase();
    await initialization;
  } catch (error) {
    console.error('Error inicializando BD en Netlify:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Error de configuracion (DATABASE_URL). Revisa variables de entorno en Netlify.' })
    };
  }
  // Netlify redirige /api/* -> /.netlify/functions/api/:splat, el path ya viene con /api.
  // Si llega sin prefijo, lo restauramos.
  const currentPath = event.path || '';
  if (!currentPath.startsWith('/api')) {
    event.path = `/api${currentPath.startsWith('/') ? currentPath : `/${currentPath}`}`;
  }
  return handler(event, context);
};
