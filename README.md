# Radio Telefónico Gases de Belén - GPS operadores

Cambios incluidos:
- Cada operador pide permiso de ubicación al entrar.
- La ubicación de cada celular se envía en tiempo real por Socket.IO.
- Todos los operadores conectados ven los puntos GPS de los demás en el mapa.
- El mapa ya no muestra textos flotantes como “TU UBICACIÓN / Gases de Belén”.
- Los puntos del mapa son iconos limpios, sin etiquetas encima.
- Al volver de otra app, la ubicación se reactiva y se vuelve a sincronizar.

Para producción:
1. Subir como Web Service Node.
2. Configurar variable MAPBOX_TOKEN con token público `pk...`.
3. Usar HTTPS para que el navegador permita micrófono y ubicación.
