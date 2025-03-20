# Use Python 3.10 slim base image for better dependency compatibility
FROM python:3.10-slim

# Set working directory inside the container
WORKDIR /app

# Install required system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm curl ffmpeg \
    g++ gcc make \
    libavcodec-dev libavformat-dev libavutil-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json for efficient caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --omit=dev

# Upgrade pip, setuptools, and wheel
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install yt-dlp and ensure correct numpy version for Spleeter
RUN pip install --no-cache-dir yt-dlp numpy==1.21.6 librosa==0.8.1

# Install Spleeter separately to avoid dependency conflicts
RUN pip install --no-cache-dir spleeter

# Copy the rest of the application
COPY . .

# Expose the port your app runs on
EXPOSE 8001

# Start the application
CMD ["node", "server.js"]
