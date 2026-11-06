const http = require('node:http');
const fs = require('node:fs');
http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(fs.readFileSync('/workspace/index.html'));
}).listen(3030, '127.0.0.1');
