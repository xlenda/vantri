import type { Metadata } from "next";
import { EMPRESA, Legal } from "../components/Legal";
import { FEE_IN, FEE_OUT, PSP_NAME, RC16 } from "../site";

export const metadata: Metadata = {
  title: "Termos de uso | Vantri",
  description: "Regras de uso da Vantri: cadastro, tarifas, cobranças, saques, MED e atividades proibidas, incluindo apostas e jogos de azar.",
  alternates: { canonical: "/termos" },
};

export default function Termos() {
  return (
    <Legal title="Termos de uso">
      <h2>1. Quem somos e o que fazemos</h2>
      <p>
        Estes Termos de uso regulam o uso da plataforma Vantri (“Vantri”, “nós”), operada por {EMPRESA}, por quem se cadastra para receber
        pagamentos (“lojista”, “você”). Ao criar a conta ou usar o painel ou a API, você declara que leu e aceita estes termos.
      </p>
      <p>
        A Vantri oferece tecnologia para criar cobranças Pix, acompanhar pagamentos, receber avisos por webhook, consultar o extrato e pedir
        saques, pelo painel ou pela API.
      </p>
      <p>
        <strong>{RC16}</strong>
      </p>
      <p>
        Cada lojista aprovado tem uma conta própria na {PSP_NAME}. A Vantri não guarda o saldo dos lojistas numa conta única em seu nome
        (“conta bolsão”).
      </p>

      <h2>2. Cadastro e aprovação</h2>
      <ul>
        <li>O cadastro pode ser feito com CPF ou CNPJ. As informações precisam ser verdadeiras, completas e atualizadas.</li>
        <li>Todo cadastro passa por análise. Podemos pedir documentos e recusar ou cancelar cadastros.</li>
        <li>
          Cadastros de CNPJ com atividade econômica (CNAE principal ou secundário) iniciada em 9200, que corresponde a apostas e jogos de azar,
          são recusados.
        </li>
        <li>
          Quando a conta é criada pela nossa equipe, você recebe uma senha temporária e precisa trocá-la no primeiro acesso.
        </li>
        <li>
          Login, senha e o código do app autenticador (2FA) são pessoais. O 2FA é obrigatório no login e nos saques pelo painel; pela API, o
          saque exige chave com o escopo <code>payouts:write</code> e, se você configurar, lista de IPs permitidos.
        </li>
      </ul>

      <h2>3. Atividades proibidas</h2>
      <p>É proibido usar a Vantri para receber ou movimentar valores relacionados a:</p>
      <ul>
        <li>
          <strong>apostas de qualquer tipo, incluindo apostas de quota fixa (“bets”), cassinos on-line, jogos de azar, loterias, rifas e sorteios</strong>;
        </li>
        <li>pirâmides financeiras, promessas de rendimento garantido e esquemas semelhantes;</li>
        <li>produtos ou serviços ilegais, falsificados ou pirateados, ou que violem direitos de terceiros;</li>
        <li>venda de dados pessoais, contas, senhas ou credenciais;</li>
        <li>recebimento de valores em nome de terceiros;</li>
        <li>qualquer operação ligada a fraude, lavagem de dinheiro ou financiamento do terrorismo.</li>
      </ul>
      <p>
        Se identificarmos atividade proibida, podemos suspender a conta, reter valores nos limites da lei e das regras da {PSP_NAME} e comunicar as
        autoridades competentes quando a lei exigir.
      </p>

      <h2>4. Tarifas</h2>
      <ul>
        <li>
          {FEE_IN} por Pix recebido, descontado do valor recebido.
        </li>
        <li>
          {FEE_OUT} por Pix enviado (saque), debitado do saldo junto com o valor sacado.
        </li>
        <li>Não há mensalidade nem taxa de setup.</li>
        <li>Tarifas diferentes podem ser combinadas por escrito. Qualquer mudança na sua tarifa é avisada com antecedência mínima de 30 dias.</li>
      </ul>

      <h2>5. Cobranças, saldo e saques</h2>
      <ul>
        <li>
          Cada cobrança vale no mínimo R$ 1,00 (e mais que a tarifa) e no máximo R$ 100.000,00, com validade de 5 minutos a 24 horas (padrão de 1
          hora).
        </li>
        <li>Quando o pagamento é confirmado pela {PSP_NAME}, o valor líquido entra no seu saldo disponível.</li>
        <li>
          Cada saque vai até R$ 50.000,00 e é enviado para a chave Pix que você informar. Pelo painel, exige o código 2FA; pela API, exige
          chave com o escopo <code>payouts:write</code> e, se você configurar, lista de IPs permitidos. É preciso ter saldo para o valor mais a
          tarifa.
        </li>
        <li>Se um saque falhar, o valor e a tarifa voltam para o seu saldo.</li>
        <li>Você é responsável por conferir a chave Pix de destino antes de confirmar o saque.</li>
      </ul>

      <h2>6. MED (Mecanismo Especial de Devolução)</h2>
      <p>
        O MED é o mecanismo do Pix, previsto nas regras do Banco Central do Brasil, que a instituição de quem pagou pode acionar quando há
        suspeita de fraude ou falha operacional.
      </p>
      <ul>
        <li>
          Quando um MED é aberto sobre uma cobrança sua, o valor contestado sai do saldo disponível e fica bloqueado. Você é avisado no painel e,
          se tiver webhook, pelo evento <code>med.opened</code>.
        </li>
        <li>
          Você pode enviar uma defesa pelo painel até o prazo mostrado no caso, com texto de 20 a 5.000 caracteres e até 5 anexos (PDF, PNG ou
          JPEG, de até 4 MB somados por defesa).
        </li>
        <li>Se o caso for encerrado a seu favor, o valor volta para o saldo disponível.</li>
        <li>Se o caso for encerrado a favor de quem pagou, o valor bloqueado é devolvido ao pagador.</li>
        <li>
          A decisão segue as regras do Pix e cabe às instituições envolvidas, não à Vantri. Ao aceitar estes termos, você autoriza o bloqueio e a
          devolução dos valores nos casos de MED.
        </li>
      </ul>

      <h2>7. API, webhooks e segurança</h2>
      <ul>
        <li>
          As chaves de API são mostradas uma única vez. Guarde-as em segredo, use só os escopos necessários e, se possível, a lista de IPs
          permitidos.
        </li>
        <li>Cada chave pode fazer até 120 requisições por minuto.</li>
        <li>
          Os webhooks são assinados no header <code>X-Vantri-Signature</code>. Você é responsável por conferir a assinatura e manter o seu
          endpoint seguro. Cada evento tem até 7 tentativas de entrega.
        </li>
        <li>Se suspeitar de vazamento de senha ou chave, revogue a chave e troque a senha imediatamente.</li>
      </ul>

      <h2>8. Suspensão e encerramento</h2>
      <p>
        Você pode pedir o encerramento da conta a qualquer momento. O saldo disponível pode ser sacado depois que os casos de MED em aberto forem
        encerrados. Podemos suspender ou encerrar a conta em caso de violação destes termos, suspeita de fraude, exigência legal ou regulatória,
        ou pedido da {PSP_NAME}.
      </p>

      <h2>9. Responsabilidades</h2>
      <p>
        Você é responsável pelos produtos e serviços que vende, pelo atendimento aos seus clientes, por reembolsos fora do MED e pelos tributos
        das suas vendas. A Vantri não responde por indisponibilidades do sistema Pix ou da {PSP_NAME}, nem por perdas causadas por uso indevido
        das suas credenciais, nos limites permitidos pela lei.
      </p>

      <h2>10. Dados pessoais</h2>
      <p>
        O tratamento de dados pessoais está descrito na <a href="/privacidade">Política de privacidade</a>.
      </p>

      <h2>11. Alterações</h2>
      <p>
        Podemos atualizar estes termos. Mudanças relevantes serão avisadas no painel antes de entrar em vigor. Continuar usando a
        Vantri depois disso significa aceitar a nova versão.
      </p>

      <h2>12. Lei e foro</h2>
      <p>
        Estes termos seguem as leis brasileiras. Fica eleito o foro do domicílio do lojista quando ele for consumidor; nos demais casos, o foro da
        sede da empresa que opera a Vantri.
      </p>
    </Legal>
  );
}
