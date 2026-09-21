const serverless = require('serverless-http');
const { app, initializeDatabase } = require('../../server');

const handler = serverless(app);
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
