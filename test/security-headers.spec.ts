import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { httpSecurityMiddleware } from '../src/common/security/http-security';

/**
 * HTTP security headers.
 *
 * The backend previously sent none: no HSTS, no nosniff, no framing policy, no
 * CSP — on a service that also serves an HTML page to a waiting-room screen.
 *
 * This suite applies the same middleware `main.ts` does, so it fails if that
 * wiring is removed rather than only proving that helmet works.
 */
describe('HTTP security headers', () => {
  let app: INestApplication;
  let url: string;
  let clinicId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(httpSecurityMiddleware());
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    clinicId = (
      await app.get(PrismaService).clinic.findFirstOrThrow({ select: { id: true } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the transport and framing headers on an API response', async () => {
    const res = await fetch(`${url}/clinics`);
    expect(res.status).toBe(200);

    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(res.headers.get('strict-transport-security')).toContain('includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
  });

  it('declares a JSON API as loading nothing and framing nowhere', async () => {
    const csp = (await fetch(`${url}/clinics`)).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('does not send CORP/COEP, which would block the cross-origin clients', async () => {
    const res = await fetch(`${url}/clinics`);
    expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
    expect(res.headers.get('cross-origin-embedder-policy')).toBeNull();
  });

  it('gives the display board a hash-based CSP instead of unsafe-inline', async () => {
    const res = await fetch(`${url}/display/${clinicId}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    // Every inline block in the page must be individually permitted — that is
    // what makes an injected script fail to run while this page still works.
    const inline = [...page.matchAll(/<(script|style)>([\s\S]*?)<\/\1>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, , body] of inline) {
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });
});
