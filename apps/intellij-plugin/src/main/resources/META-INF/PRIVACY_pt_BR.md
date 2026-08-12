# Privacidade

O plugin para IntelliJ não envia telemetria nem faz requisições de análise. Ele se conecta apenas às organizações Salesforce selecionadas pelo usuário por meio do Salesforce CLI instalado localmente e armazena os logs Apex baixados no projeto atual, em `apexlogs/`.

A exportação de diagnósticos sanitizados só é criada mediante solicitação explícita. Ela exclui código-fonte, conteúdo dos logs Apex, termos de busca, nomes de usuário, aliases, identificadores de organização, URLs de instância, tokens de acesso e caminhos locais.
