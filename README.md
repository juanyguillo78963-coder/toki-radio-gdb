# Radio Teléfono Gases de Belén — Mapbox GPS Real

Versión con interfaz militar, PTT y mapa real de repartidores con Mapbox.

## Qué trae
- Mapa real Mapbox dark.
- Ubicación GPS real por celular.
- Marcadores en vivo por Socket.io.
- Movimiento en tiempo real de repartidores.
- Popup con nombre, estado y velocidad.
- Si alguien transmite, su marcador cambia a alerta.
- Fallback táctico si no hay token Mapbox.

## Cómo activar Mapbox en Render
1. Crea una cuenta en Mapbox.
2. Entra a Account > Access tokens.
3. Copia el token público que empieza por `pk.`.
4. En Render abre tu Web Service.
5. Ve a Environment.
6. Agrega:

```bash
MAPBOX_TOKEN=pk.tu_token_de_mapbox
```

7. Guarda y redeploy.

## También puedes activarlo desde la app
Si no pones variable en Render, toca el botón `ACTIVAR MAPBOX` dentro del mapa y pega el token público `pk.`. Queda guardado en ese celular.

## Render
Build Command:
```bash
npm install
```
Start Command:
```bash
npm start
```

Ruta principal:
`/s/gases-belen`

## Importante
Para GPS real el celular debe permitir ubicación. En iPhone/Android el navegador debe estar en HTTPS, y Render ya lo entrega con HTTPS.
