import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const distDir = resolve(process.env.WEB_DIST_DIR ?? 'dist');
const indexPath = join(distDir, 'index.html');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp']
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const filePath = resolve(
    distDir,
    normalize(requestedPath === '/' ? '/index.html' : requestedPath).replace(/^[/\\]+/, '')
  );

  if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  const staticPath = await resolveStaticPath(filePath);
  const headers = {
    'Cache-Control': staticPath === indexPath ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Type': contentTypes.get(extname(staticPath)) ?? 'application/octet-stream'
  };

  response.writeHead(200, headers);
  createReadStream(staticPath).pipe(response);
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ service: 'web', event: 'listening', host, port }));
});

async function resolveStaticPath(filePath) {
  try {
    const fileStat = await stat(filePath);

    if (fileStat.isFile()) {
      return filePath;
    }
  } catch {
    return indexPath;
  }

  return indexPath;
}
