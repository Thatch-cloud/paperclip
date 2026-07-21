# Portal Contracts

`npm run contract:check` verifies that the Portal OpenAPI TypeScript contract file is fresh.

The check uses the accepted Server OpenAPI artifact produced locally by `server/src/routes/openapi.ts#buildOpenApiSpec`. It regenerates `ui/src/api/generated/openapi-client.d.ts` from that artifact and fails when the checked-in file differs.

To update the generated Portal contract after an accepted Server API change:

```bash
pnpm --filter @paperclipai/server exec tsx ../scripts/check-portal-contract.ts --write
npm run contract:check
```

The script also compares a deliberately stale fixture at `scripts/fixtures/stale-portal-openapi-client.d.ts` with `--expect-stale` so CI proves stale generated output is caught.
