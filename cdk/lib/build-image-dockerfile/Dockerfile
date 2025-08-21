FROM public.ecr.aws/docker/library/node:20-bullseye

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Set working directory for app source
WORKDIR /app