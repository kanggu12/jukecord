/**
 * A browser for the end-to-end logins, as small as one can be: it keeps cookies per site, follows redirects itself
 * (so each one can be seen), and fills in and sends a login form the way a person's browser would.
 */

/** One step of a browser's way: the address and the answer's status. */
export interface Hop {
  readonly url: string;
  readonly status: number;
}

export class Browser {
  // Cookies by host: name to value. Paths and expiry are kept simple: a cookie with Max-Age=0 is removed.
  private readonly jar = new Map<string, Map<string, string>>();
  /** Every address visited, in order, with its answer's status. */
  readonly hops: Hop[] = [];

  /** The cookies this browser holds for a site, as a Cookie header. */
  cookieFor(url: string): string {
    const cookies = this.jar.get(new URL(url).host);
    return cookies ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : '';
  }

  /** One cookie's value for a site, or undefined. */
  cookie(url: string, name: string): string | undefined {
    return this.jar.get(new URL(url).host)?.get(name);
  }

  // Keeps what a response's Set-Cookie headers say.
  private keep(url: string, response: Response): void {
    const host = new URL(url).host;
    const cookies = this.jar.get(host) ?? new Map<string, string>();
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const gone = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '';
      if (gone) cookies.delete(name);
      else cookies.set(name, value);
    }
    this.jar.set(host, cookies);
  }

  /** Sends one request with this browser's cookies, without following a redirect. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = this.cookieFor(url);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    this.keep(url, response);
    this.hops.push({ url, status: response.status });
    return response;
  }

  /** Goes to an address and follows its redirects (at most 20): the last answer and where it ended. */
  async go(url: string, init: RequestInit = {}): Promise<{ response: Response; url: string }> {
    let here = url;
    let response = await this.request(here, init);
    for (let hop = 0; hop < 20 && response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get('location');
      if (!location) break;
      // The answer's body is not read: dropped so the connection is free.
      await response.body?.cancel();
      here = new URL(location, here).href;
      // A redirect after a form is a plain GET, as browsers do it.
      response = await this.request(here);
    }
    return { response, url: here };
  }

  /**
   * Fills in the page's login form (the one with a password field) and sends it, as a person pressing its key: its
   * hidden fields as they are, the name and password in the fields named.
   */
  async submit(
    page: string,
    pageUrl: string,
    fields: Record<string, string>,
  ): Promise<{ response: Response; url: string }> {
    const form = /<form[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(page);
    if (!form) throw new Error(`no form on ${pageUrl}`);
    const action = new URL(form[1]?.replaceAll('&amp;', '&') ?? '', pageUrl).href;
    const body = new URLSearchParams();
    // Hidden fields first, as they are on the page.
    for (const input of (form[2] ?? '').matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = /\bname="([^"]+)"/.exec(input[0])?.[1];
      const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1] ?? '';
      if (name) body.set(name, value.replaceAll('&amp;', '&'));
    }
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    return this.go(action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(pageUrl).origin },
      body: body.toString(),
    });
  }
}
