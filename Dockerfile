# DEDLIT Studio — imagen para correr en un NAS o servidor casero 24/7.
# Cero dependencias de runtime: solo Node. Se añaden bash y git porque el
# modo agente los usa (run_command en Linux ejecuta /bin/bash; git/gh son
# herramientas habituales del agente).
FROM node:22-alpine

RUN apk add --no-cache bash git

WORKDIR /app

# Solo lo necesario en runtime (sin dev deps: pkg no se usa en el contenedor)
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

# La configuración, el historial, el RAG y los medios viven en el HOME del
# usuario (~/.dedlit). Monta un volumen aquí para que persistan entre
# reinicios del contenedor:  -v dedlit-data:/root/.dedlit
VOLUME ["/root/.dedlit"]

ENV DEDLIT_PORT=8642
EXPOSE 8642 8643

CMD ["node", "server.js"]
