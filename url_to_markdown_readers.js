const apple_dev_parser = require('./url_to_markdown_apple_dev_docs.js');
const processor = require('./url_to_markdown_processor.js');
const filters = require('./url_to_markdown_common_filters.js');
const JSDOM = require('jsdom').JSDOM;
const https = require('https');
const http = require('http');
const { URL } = require('url');
const zlib = require('zlib');

const failure_message  = "Sorry, could not fetch and convert that URL";

const apple_dev_prefix = "https://developer.apple.com";
const stackoverflow_prefix = "https://stackoverflow.com/questions";

const timeoutMs = 15 * 1000;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const MAX_BYTES = 10 * 1024 * 1024;

function fetch_url (inputUrl, success, failure, redirectCount = 0, state) {
  const MAX_REDIRECTS = 5;
  if (!state) state = { cookie: '', referer: inputUrl };

  try {
    const u = new URL(inputUrl);
    const isHttps = (u.protocol === 'https:');
    if (!isHttps && u.protocol !== 'http:') {
      return failure(400);
    }
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': state.referer
    };
    if (state.cookie) headers['Cookie'] = state.cookie;

    const req = client.get(u, { agent, headers }, (res) => {
      const status = res.statusCode || 0;

      // Accumulate cookies for subsequent hops
      const set = res.headers['set-cookie'];
      if (Array.isArray(set)) {
        const kv = set.map(c => c.split(';')[0]).join('; ');
        state.cookie = state.cookie ? `${state.cookie}; ${kv}` : kv;
      }

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        if (!location) { res.resume(); return failure(status); }
        if (redirectCount >= MAX_REDIRECTS) { res.resume(); return failure(310); }
        const nextUrl = new URL(location, u).toString();
        res.resume();
        state.referer = u.toString();
        return fetch_url(nextUrl, success, failure, redirectCount + 1, state);
      }

      // Non-2xx
      if (status < 200 || status >= 300) {
        res.resume();
        return failure(status);
      }

      // Decompress if needed
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.includes('br')) {
          stream = res.pipe(zlib.createBrotliDecompress());
        } else if (enc.includes('gzip')) {
          stream = res.pipe(zlib.createGunzip());
        } else if (enc.includes('deflate')) {
          stream = res.pipe(zlib.createInflate());
        }
      } catch (e) {
        res.resume();
        return failure();
      }

      // Read with size limit
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          try { stream.destroy(); } catch {}
          try { req.destroy(); } catch {}
          return failure(413); // Payload too large
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);

        // Handle meta refresh redirects (immediate)
        const headAscii = buffer.slice(0, 4096).toString('ascii');
        const metaRefresh = headAscii.match(/http-equiv=["']?refresh["']?[^>]*content=["']?\s*(\d+)\s*;\s*url=([^"'>\s]+)/i);
        if (metaRefresh) {
          const delay = parseInt(metaRefresh[1], 10);
          if (!Number.isNaN(delay) && delay <= 2 && redirectCount < MAX_REDIRECTS) {
            const refreshUrl = new URL(metaRefresh[2], u).toString();
            return fetch_url(refreshUrl, success, failure, redirectCount + 1, state);
          }
        }

        // Detect charset from headers or meta tag
        const contentType = res.headers['content-type'] || '';
        let m = contentType.match(/charset=([^;]+)/i);
        let charset = m ? m[1].trim().toLowerCase() : null;

        if (!charset) {
          let m1 = headAscii.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9_-]+)/i);
          if (m1) charset = m1[1].trim().toLowerCase();
          let m2 = headAscii.match(/<meta[^>]+http-equiv=["']content-type["'][^>]*content=["'][^"']*charset=([^"'>\s]+)/i);
          if (!charset && m2) charset = m2[1].trim().toLowerCase();
        }
        if (!charset) charset = 'utf-8';

        let html;
        if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
          html = buffer.toString('latin1');
        } else {
          html = buffer.toString('utf8');
        }

        success(html);
      });
      stream.on('error', () => failure());
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      failure();
    });
    req.on('error', (err) => failure(err));
  } catch (e) {
    failure(e);
  }
}

class html_reader {
	read_url(url, res, options) {
		try {
			fetch_url(url, (html) => {				
				html = filters.strip_style_and_script_blocks(html);
				const document = new JSDOM(html);
				const id = "";
				let markdown = processor.process_dom(url, document, res, id, options);
				res.send(markdown);
			}, (code) => {
				if (code && Number.isInteger(code)) {
					res.status(502).send(failure_message + " as the website you are trying to convert returned status code " + code);
				} else {
					res.status(504).send(failure_message);
				}
			});
		} catch(error) {
			res.status(400).send(failure_message);
		}
	}
}

class apple_reader {
	read_url(url, res, options) {
		let json_url = apple_dev_parser.dev_doc_url(url);
		fetch_url(json_url, (body) => {	
            let json = JSON.parse(body);
            let markdown = apple_dev_parser.parse_dev_doc_json(json, options);
            res.send(markdown);
		}, () => {
			res.status(504).send(failure_message);
		});
	}
}

class stack_reader {
	read_url(url, res, options) {
		try {
			fetch_url(url, (html) => {
				html = filters.strip_style_and_script_blocks(html);
				const document = new JSDOM(html);	
				let markdown_q = processor.process_dom(url, document, res, 'question', options );
				options.inline_title = false;
				let markdown_a = processor.process_dom(url, document, res, 'answers', options );
				if (markdown_a.startsWith('Your Answer')) {
					res.send(markdown_q);
				}
				else {
					res.send(markdown_q + "\n\n## Answer\n"+ markdown_a);
				}
			}, () => {
				res.status(504).send(failure_message);
			});
		} catch(error) {
			res.status(400).send(failure_message);
		}
	}
}

module.exports = {
	html_reader,
	stack_reader,
	apple_reader,
	reader_for_url: function (url) {
		if (url.startsWith(apple_dev_prefix)) {
			return new apple_reader;
		} else if (url.startsWith(stackoverflow_prefix)) {		
			return new stack_reader;
		} else {
			return new html_reader;
		}
	},
	ignore_post: function(url) {
		if (url) {
			if (url.startsWith(stackoverflow_prefix)) {
				return true;
			}
		} else {
			return false;
		}
	}
}
