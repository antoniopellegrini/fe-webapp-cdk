FROM public.ecr.aws/docker/library/node:20-bullseye

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Set PNPM home for caching
ENV PNPM_HOME=/root/.pnpm

# Copy package files first for layer caching
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile
