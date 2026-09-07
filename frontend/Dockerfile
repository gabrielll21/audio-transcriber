FROM nginx:1.27-alpine

WORKDIR /usr/share/nginx/html

COPY index.html ./
COPY css ./css
COPY js ./js

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
