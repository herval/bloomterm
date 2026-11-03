# cvm

Fatos relevantes (material facts) that Brazilian listed companies file with CVM, from RAD,
CVM's public filing system.

## Access

RAD's public search, `POST /ENET/frmConsultaExternaCVM.aspx/ListarDocumentos`, the same
search its own page runs: a read with a JSON body, no sign-in, no keys. Polled every 15
minutes over the last day or since the last poll.

## Provides

- `news` (kind `filing`): company, subject, delivery time (Brasília), and a link to the
  document viewer. Filers bloomterm knows by name (`COMPANIES` in `@bloomterm/core`) are tagged
  with their B3 tickers.

## Limits

- Fato Relevante only (IPE category 4); comunicados ao mercado aren't read yet.
- RAD answers in its own delimited format (`$&` between fields, `&*` between rows); a change
  there breaks `parseRad`, which the tests pin.
- Filers outside `COMPANIES` aren't tagged by the source; the agent may tag them later.

## Verified

2026-10-28: the search returned that day's fatos relevantes.
