import {
  MINT_PRICE_TOKENS,
  REDEEM_PRICE_TOKENS,
  SUPPLY_CAP,
  SPREAD_BPS,
  TOKEN,
} from "@config";
import { groupDigits } from "@/lib/format";

export const metadata = { title: "Docs — PumpBrokers" };

export default function DocsPage() {
  const spreadPct = SPREAD_BPS / 100;

  return (
    <div className="max-w-prose space-y-10">
      <header>
        <h1 className="text-xl text-bone">How it works</h1>
        <p className="mt-2 text-sm text-muted">
          Short version: mint for {groupDigits(MINT_PRICE_TOKENS)}, sell back for{" "}
          {groupDigits(REDEEM_PRICE_TOKENS)}, any time, enforced by the program.
        </p>
      </header>

      <Section title="Minting">
        <p>
          You pay exactly {groupDigits(MINT_PRICE_TOKENS)} ${TOKEN.symbol} and
          receive one random unminted PumpBroker. There are exactly {SUPPLY_CAP},
          and the cap is tracked by the program, not by us.
        </p>
        <p>
          Your tokens go to a <strong>program-owned treasury</strong>, not to a
          personal wallet. Nobody can move them except through the program&apos;s own
          rules.
        </p>
        <p>
          You also pay roughly 0.003 SOL of account rent for the NFT itself. That
          is the cost of the asset existing on Solana, and it is why we do not
          pre-mint all {SUPPLY_CAP} up front.
        </p>
      </Section>

      <Section title="Selling back">
        <p>
          Return any PumpBroker to the program and receive{" "}
          {groupDigits(REDEEM_PRICE_TOKENS)} ${TOKEN.symbol} — {spreadPct}% below the
          mint price. That {spreadPct}% spread stays in the treasury, and it is what
          makes the whole thing self-funding: every mint puts more in than any single
          sell-back takes out.
        </p>
        <p>
          A broker you sell back is <strong>not burned</strong>. It returns to the
          mintable pool, so supply stays at {SUPPLY_CAP} and the same art can
          circulate to a new holder.
        </p>
      </Section>

      <Section title="What the floor actually guarantees">
        <p>
          Two things make the floor real rather than a promise, and it is worth
          being precise about both:
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Sell-back checks the treasury before paying. If it cannot cover the
            payout, it fails with a clear message instead of half-completing. The
            site shows <em>redemptions currently available</em> so you can see this
            before you try.
          </li>
          <li>
            The program authority <strong>cannot</strong> withdraw the funds backing
            outstanding sell-backs. Withdrawals are capped at the surplus above{" "}
            <code>brokers held × {groupDigits(REDEEM_PRICE_TOKENS)}</code>.
          </li>
        </ul>
        <p className="border-2 border-down bg-down/10 p-3 text-bone">
          The floor is denominated in ${TOKEN.symbol}, not dollars. If the token&apos;s
          market price falls, {groupDigits(REDEEM_PRICE_TOKENS)} ${TOKEN.symbol} is
          worth less in dollar terms. This is a token-denominated floor and nothing
          more.
        </p>
      </Section>

      <Section title="The airdrop">
        <p>
          100 of the {SUPPLY_CAP} brokers carry an <code>Airdrop</code> attribute
          naming a tokenized stock — 10 pieces per ticker across 10 tickers.
        </p>
        <p>
          Holders of those pieces receive a distribution of the matching asset. The
          holder list is snapshotted <strong>from chain</strong> at a published
          time. Whoever holds the piece at that moment receives it; the claim does
          not follow the NFT on resale afterwards.
        </p>
        <p>
          A ticker only becomes eligible once its mint address has been verified.
          Until then it is shown as pending, and the distribution tool refuses to
          run for it — that is a deliberate safety gate, not an oversight.
        </p>
      </Section>

      <Section title="Emergency pause">
        <p>
          Mint and sell-back can each be paused independently by the program
          authority. In most incidents the right move is to pause minting while
          leaving sell-back open, so no new obligations are created but existing
          holders are never trapped.
        </p>
      </Section>

      <Section title="Risks, plainly">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            The floor is in ${TOKEN.symbol}. Its dollar value can fall to
            approximately nothing.
          </li>
          <li>
            If the treasury is drained faster than mints replenish it, sell-back
            fails until it recovers. The reserve cap makes this unlikely, not
            impossible.
          </li>
          <li>
            Which broker you receive is chosen using on-chain values that a
            sophisticated actor could bias. Every piece has the same sell-back
            price, so the incentive is limited — but it is not a fair lottery and
            we are not going to claim it is.
          </li>
          <li>
            This is art with a mechanic attached. It is not an investment product,
            and nothing here is a promise of return.
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-sm text-neon">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}
