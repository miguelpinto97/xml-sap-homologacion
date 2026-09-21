# Homologacion de campos XML SAP

Visor interno de las hojas de `Homologacion_Campos_XML_SAP.xlsx`, con datos persistidos en Neon/PostgreSQL.

## Configuracion

1. Instala Node.js 18 o superior.
2. Abre una terminal en esta carpeta y ejecuta `npm install`.
3. Copia `.env.example` como `.env`.
4. Abre `.env` y reemplaza `DATABASE_URL` por la cadena de conexion de Neon.
5. Ejecuta `npm start`.
6. Abre `http://localhost:8765`.

En el primer arranque se crean las tablas y se carga el contenido de `homologacion_campos_sap.json`. Los siguientes arranques consultan los datos directamente desde Neon.

## Despliegue en Netlify

Archivos necesarios ya incluidos: `netlify.toml` (publish `Web`, functions `netlify/functions`), `netlify/functions/api.js` (Express via `serverless-http`), `package.json` (`serverless-http`, `@neondatabase/serverless`, `express`, `dotenv`), `Web/` (frontend), `homologacion_campos_sap.json` (semilla incluida en el bundle).

1. Sube este proyecto a GitHub.
2. En Netlify: Add new site → Import an existing project → conecta el repo.
   - Build command: vacio (sitio estatico + functions, no requiere build).
   - Publish directory: `Web`.
   - Functions directory: `netlify/functions`.
3. En Site settings → Environment variables agrega:
   - `DATABASE_URL` = cadena de Neon (`postgresql://...?sslmode=require`)
4. Deploy. El frontend usa `/api/*` → `/.netlify/functions/api/:splat` (ver `netlify.toml`).
5. La primera invocacion a `/api/*` crea el schema y hace seed desde el JSON si la BD esta vacia.

## Campo SAP por empresa

Al entrar, cada usuario selecciona una empresa. En las secciones de campos comunes aparece la columna `Campo SAP`:

- Si no existe un aporte de otra empresa, se puede escribir y guardar un valor.
- Si otra empresa ya aporto un valor, aparece la alerta `Validar` y el boton `Estoy de acuerdo`.
- El usuario puede aceptar ese valor o editarlo y guardar uno propio.
- Los aportes se guardan por empresa y nunca reemplazan el valor de otra empresa.

## Seguridad

- No subas `.env` a un repositorio.
- No pegues la cadena real de Neon en `server.js`, `app.js` ni en archivos publicos.
- El backend es el unico componente que usa `DATABASE_URL`; el navegador solo consume `/api/sheets`.

## Estructura de datos

- `documents`: archivo fuente importado.
- `sheets`: hojas y orden de presentacion.
- `sheet_rows`: numero de fila y celdas en formato JSONB.
