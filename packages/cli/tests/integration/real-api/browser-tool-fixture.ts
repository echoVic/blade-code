import { createServer, type Server } from 'node:http';

export interface BrowserToolFixture {
  origin: string;
  prompt: string;
  finalMarker: string;
  requests(): readonly string[];
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Browser Tool fixture has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function createBrowserToolFixture(
  nonce: string
): Promise<BrowserToolFixture> {
  if (!/^[a-z0-9_]{8,128}$/.test(nonce)) {
    throw new Error('Browser Tool fixture nonce is invalid');
  }
  const requests: string[] = [];
  const finalMarker = `BROWSER_TOOL_OK_${nonce}`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    if (pathname === '/second') {
      response.end(
        '<!doctype html><html><body><h1>Second page ready</h1></body></html>'
      );
      return;
    }
    if (pathname !== '/') {
      response.writeHead(404).end('not found');
      return;
    }
    response.end(`<!doctype html>
      <html>
        <body>
          <h1>Browser Tool Qualification</h1>
          <label>Name <input aria-label="Name"></label>
          <select aria-label="Mode">
            <option value="fast">Fast</option>
            <option value="safe">Safe</option>
          </select>
          <label>Enabled <input type="checkbox" aria-label="Enabled"></label>
          <button onclick="
            const name = document.querySelector('[aria-label=Name]').value;
            const mode = document.querySelector('[aria-label=Mode]').value;
            const enabled = document.querySelector('[aria-label=Enabled]').checked;
            if (name === 'Blade' && mode === 'safe' && enabled) {
              document.querySelector('#status').textContent = 'Saved';
              document.querySelector('#result').textContent = '${finalMarker}';
              console.log('browser-tool-saved');
            }
          ">Submit</button>
          <div id="status">Pending</div>
          <div id="result"></div>
        </body>
      </html>`);
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const prompt = [
    'Use only ToolSearch and the six native Browser tools for this task.',
    'First call ToolSearch exactly once with this query:',
    'select:BrowserNavigate,BrowserSnapshot,BrowserInteract,BrowserWait,BrowserInspect,BrowserPage',
    'and max_results 6.',
    `Navigate to ${origin}/ with BrowserNavigate action goto.`,
    'Release protocol requirement: immediately after BrowserNavigate, call BrowserSnapshot even though navigation already returned a snapshot.',
    'Use only the explicit BrowserSnapshot result pageId, snapshotId, refs, and origin for the first interaction.',
    'Perform exactly one BrowserInteract per assistant response. Every interaction invalidates its input snapshot.',
    'After each successful BrowserInteract, use only that result observation for the next interaction. After a stale-snapshot error, call BrowserSnapshot before retrying.',
    'Use BrowserInteract to fill Name with Blade, select Mode with exactly {"kind":"select","values":["safe"]}, check Enabled, and click Submit.',
    'Use BrowserWait for exact visible text Saved.',
    'Use BrowserInspect find for BROWSER_TOOL_OK_, then inspect console and network, and capture a screenshot.',
    'Use BrowserPage open to create a second page, navigate it to the same origin /second, list pages, select the first page, and close the second page.',
    'Read the complete BROWSER_TOOL_OK_ value only from the post-submit page state.',
    'Your final response must be exactly that complete discovered value and nothing else.',
  ].join('\n');

  return {
    origin,
    prompt,
    finalMarker,
    requests: () => [...requests],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
