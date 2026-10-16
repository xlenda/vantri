import type { Metadata } from "next";
import { EMPRESA, Legal } from "../components/Legal";
import { PSP_NAME, RC16 } from "../site";

export const metadata: Metadata = {
  title: "Política de privacidade | Vantri",
  description: "Como a Vantri trata dados pessoais de lojistas e pagadores, conforme a LGPD (Lei nº 13.709/2018).",
  alternates: { canonical: "/privacidade" },
};

export default function Privacidade() {
  return (
    <Legal title="Política de privacidade">
      <p>
        Esta política explica como a Vantri trata dados pessoais, conforme a Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018). Ela vale
        para o site, o painel e a API.
      </p>

      <h2>1. Quem é o controlador</h2>
      <p>O controlador dos dados é {EMPRESA}.</p>
      <p>{RC16}</p>

      <h2>2. Quais dados tratamos</h2>
      <ul>
        <li>
          <strong>Cadastro:</strong> nome ou razão social, nome fantasia, CPF ou CNPJ, e-mail e segmento de atuação.
        </li>
        <li>
          <strong>Acesso:</strong> senha (guardada apenas como hash), segredo do app autenticador (criptografado), endereço IP, data e hora de
          acesso.
        </li>
        <li>
          <strong>Transações:</strong> valor, descrição, status, chave Pix de destino dos saques e identificador da transação Pix.
        </li>
        <li>
          <strong>Dados de quem paga as suas cobranças:</strong> nome e CPF ou CNPJ mascarado, recebidos da {PSP_NAME} quando o Pix é pago.
        </li>
        <li>
          <strong>MED:</strong> texto da defesa e arquivos anexados por você.
        </li>
        <li>
          <strong>Integrações:</strong> chaves de API (guardadas apenas como hash), IPs permitidos, endereços de webhook e histórico de entregas.
        </li>
      </ul>

      <h2>3. Para que usamos e com qual base legal</h2>
      <ul>
        <li>Prestar o serviço (cobranças, extrato, saques, webhooks, MED): execução de contrato (art. 7º, V, da LGPD).</li>
        <li>
          Cumprir obrigações legais e regulatórias, como prevenção à lavagem de dinheiro (Lei nº 9.613/1998) e atendimento a autoridades:
          obrigação legal (art. 7º, II).
        </li>
        <li>Proteger contas, prevenir fraude e bloquear robôs no login e no cadastro: legítimo interesse (art. 7º, IX).</li>
        <li>Defender direitos em processos judiciais, administrativos ou arbitrais: exercício regular de direitos (art. 7º, VI).</li>
      </ul>

      <h2>4. Com quem compartilhamos</h2>
      <ul>
        <li>Com a {PSP_NAME}, que opera as contas e as transações Pix.</li>
        <li>Com provedores de hospedagem e banco de dados que mantêm a plataforma, sob contrato e só para esse fim.</li>
        <li>Com a Cloudflare, pelo Turnstile, que verifica se quem acessa as telas de entrar e de cadastro não é um robô.</li>
        <li>Com autoridades públicas, quando a lei ou uma ordem judicial exigir.</li>
      </ul>
      <p>Não vendemos dados pessoais.</p>
      <p>
        Alguns provedores podem tratar dados fora do Brasil. Nesses casos, a transferência segue as hipóteses do art. 33 da LGPD.
      </p>

      <h2>5. Por quanto tempo guardamos</h2>
      <ul>
        <li>Dados de cadastro e de transações: enquanto a conta existir e, depois do encerramento, por pelo menos 5 anos (Lei nº 9.613/1998, art. 10).</li>
        <li>Registros de acesso: por pelo menos 6 meses (Marco Civil da Internet, Lei nº 12.965/2014, art. 15).</li>
        <li>Os demais dados são apagados ou anonimizados quando deixam de ser necessários.</li>
      </ul>

      <h2>6. Como protegemos</h2>
      <ul>
        <li>Senhas guardadas com hash Argon2, nunca em texto.</li>
        <li>CPF/CNPJ e segredo do 2FA criptografados no banco de dados.</li>
        <li>Autenticação em dois fatores obrigatória para entrar e para sacar.</li>
        <li>Chaves de API guardadas só como hash e com escopo limitado.</li>
        <li>Conexão sempre por HTTPS.</li>
      </ul>

      <h2>7. Cookies</h2>
      <p>
        Usamos apenas o cookie de sessão necessário para manter você conectado ao painel. Não usamos cookies de publicidade nem de análise de
        audiência. O Turnstile, da Cloudflare, pode ler dados técnicos do navegador para a verificação anti-robô.
      </p>

      <h2>8. Seus direitos</h2>
      <p>Pelo art. 18 da LGPD, você pode pedir, a qualquer momento:</p>
      <ul>
        <li>confirmação de que tratamos seus dados e acesso a eles;</li>
        <li>correção de dados incompletos, inexatos ou desatualizados;</li>
        <li>anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desacordo com a lei;</li>
        <li>portabilidade dos dados;</li>
        <li>informação sobre com quem compartilhamos seus dados;</li>
        <li>revisão de decisões tomadas só com base em tratamento automatizado.</li>
      </ul>
      <p>
        Dados que a lei obriga a guardar (item 5) não podem ser apagados antes do prazo. Você também pode reclamar à Autoridade Nacional de
        Proteção de Dados (ANPD).
      </p>

      <h2>9. Encarregado (DPO)</h2>
      <p>Canal do encarregado pelo tratamento de dados: [nome e e-mail a definir antes de operar].</p>

      <h2>10. Alterações</h2>
      <p>Podemos atualizar esta política. A data da última atualização fica no topo da página, e mudanças relevantes serão avisadas no painel.</p>
    </Legal>
  );
}
