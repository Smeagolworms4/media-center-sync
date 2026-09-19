# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# API de la passerelle — image de production.
#
# Construction en deux temps : un étage qui compile avec l'outillage complet, un
# étage final qui n'embarque que le résultat et les dépendances d'exécution.
# L'image livrée ne contient ni TypeScript, ni tests, ni sources.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS builder

WORKDIR /app

# Les manifestes d'abord : tant qu'ils ne changent pas, Docker réutilise la couche
# d'installation, de loin la plus longue.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/front/package.json packages/front/

RUN apk add --no-cache python3 make g++ \
	&& npm ci --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/api packages/api

RUN npm run build --workspace @mcs/shared \
	&& npm run build --workspace @mcs/api

# --- Dépendances d'exécution -----------------------------------------------
#
# Étage distinct, et non un élagage du précédent : celui-ci porte les dépendances
# de l'interface — Vue, Vuetify, Vite — dont l'api n'a que faire.

FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/front/package.json packages/front/

RUN apk add --no-cache python3 make g++ \
	&& npm ci --omit=dev \
		--workspace @mcs/api --workspace @mcs/shared --include-workspace-root \
	&& npm cache clean --force

# --- Image finale ----------------------------------------------------------

FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# ⚠️ **On garde l'utilisateur `node` de l'image de base, en uid 1000.**
#
# Les bibliothèques sont **montées depuis l'hôte**, où elles appartiennent à
# l'utilisateur du NAS — uid 1000 dans l'immense majorité des cas. Un conteneur en
# 1001 n'y a alors pas le droit d'écrire, et le premier transfert échoue sur un
# `EACCES` que rien n'annonce : l'application démarre, se déclare saine, et refuse
# le premier fichier.

COPY --from=builder /app/package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/api/package.json packages/api/
COPY --from=builder /app/packages/api/dist packages/api/dist

# Le dossier de travail des transferts. Monté sur disque en production ; il existe
# ici pour que l'application démarre même sans montage.
RUN mkdir -p /app/var/transfer /media && chown -R node:node /app/var

USER node

ENV API_PORT=4200
ENV PEER_PORT=4210
EXPOSE 4200 4210

# Vérifie que l'api **répond** et que sa base est joignable, pas seulement que le
# processus vit : une base coupée laisse le serveur debout mais inutilisable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/dist/main.js"]
