# Base image
FROM node:18

# Diretório de trabalho
WORKDIR /app

# Copia arquivos
COPY package*.json ./
COPY . .

# Instala dependências
RUN npm install

# Expõe a porta padrão
EXPOSE 3000

# Comando de inicialização
CMD ["node", "app.js"]
