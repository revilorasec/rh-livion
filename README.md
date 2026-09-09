# RH Livion 1.10.0

Cadastros operacionais no Supabase (rh-api / portal_rh_data); anexos no OneDrive via Microsoft Graph. Abrir pelo Portal Livion: https://portal.livionsolutions.com.br/.

A área **Férias** centraliza funcionário, período aquisitivo, período concessivo, datas de início e fim, dias calculados, abono pecuniário, adiantamento do 13º, status, aviso, pagamento e observações. Os registros ficam em `DB.ferias` e também entram na exportação Excel.

## Operação

- Abertura direta encaminha ao Portal. JSONs legados são históricos; não há importação automática nem gravação operacional neles.
- Conectar arquivos usa login Microsoft com a mesma conta validada pela API. Usuários externos e perfis sem documentos não acessam essa função. Compartilhamentos do OneDrive continuam sendo controlados pelo Microsoft 365.
- Leitura de dados exige permissão básica. Gravação completa exige edição, salários, banco, dados sensíveis e documentos, mais perfil interno. Conflito de revisão retorna 409; preserve a edição antes de recarregar.
- Bootstrap da API restrito a administrador, sem substituição forçada. Nenhuma migração é necessária.
- Permissões de arquivos já usadas pelo RH: User.Read e Files.ReadWrite.All. Um consentimento Microsoft pendente deve ser revisado pelo administrador; o aplicativo não amplia compartilhamentos.

## Desenvolvimento

Frontend: index.html. Backend: supabase/functions/rh-api/index.ts. Testes: `node --disable-warning=ExperimentalWarning --test test.mjs` (Node 24).

29 testes sintéticos aprovados. Atualização condicional validada também em tabela temporária PostgreSQL com rollback, sem alterar os cadastros. Isso não equivale a um teste de escrita nos dados de produção.

Publicar HTML e backend juntos; preferir HTML primeiro (backend anterior aceita o campo revision adicional). Clientes antigos sem revision recebem 428 após atualização da API e precisam atualizar a página. verify_jwt=false é necessário para autenticação Microsoft própria já existente; a função valida identidade via Graph e acesso no cadastro do Portal.

Referências: https://supabase.com/docs/reference/javascript/update e https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0.

Não incluir dados.json, arquivos de funcionários, configurações Azure ou credenciais neste repositório.
