/**
 * Sealed-bid agent auctions via commit/reveal (PRODUCT_SPEC §12, P1).
 *
 * In an open auction between machines, the last bidder to see the book wins by
 * a nanodollar, every time. Commit/reveal removes that: bidders publish
 * `hash(bid ‖ salt ‖ auctionId ‖ bidder)` during the commit window and reveal
 * afterwards. A bid that does not match its commitment is discarded, and the
 * auction id is inside the hash so a commitment cannot be replayed into a
 * different auction.
 */

import { domainHash } from "../canonical/json";
import { fail, ok, violation, type Outcome } from "../errors/index";
import type { Nanos } from "../units/money";

export interface AuctionCommitment {
  readonly auctionId: string;
  readonly bidderAgentId: string;
  readonly commitmentHash: string;
  readonly committedAt: Date;
}

export interface AuctionReveal {
  readonly auctionId: string;
  readonly bidderAgentId: string;
  readonly bid: Nanos;
  readonly salt: string;
  readonly revealedAt: Date;
}

export function commitmentHash(
  auctionId: string,
  bidderAgentId: string,
  bid: Nanos,
  salt: string,
): string {
  return domainHash("auction.commit.v1", { auctionId, bidderAgentId, bid, salt } as never);
}

export interface AuctionWindows {
  readonly commitClosesAt: Date;
  readonly revealClosesAt: Date;
}

export interface AuctionResult {
  readonly auctionId: string;
  readonly winnerAgentId: string;
  readonly winningBid: Nanos;
  /** Second-lowest revealed bid, when there was one. */
  readonly runnerUpBid: Nanos | null;
  readonly validReveals: number;
  readonly discardedReveals: readonly { bidderAgentId: string; reason: string }[];
}

export function resolveAuction(
  auctionId: string,
  commitments: readonly AuctionCommitment[],
  reveals: readonly AuctionReveal[],
  windows: AuctionWindows,
  reserve: Nanos,
): Outcome<AuctionResult> {
  const byBidder = new Map<string, AuctionCommitment>();
  for (const commitment of commitments) {
    if (commitment.auctionId !== auctionId) continue;
    if (commitment.committedAt > windows.commitClosesAt) continue;
    byBidder.set(commitment.bidderAgentId, commitment);
  }

  const discarded: { bidderAgentId: string; reason: string }[] = [];
  const valid: { bidderAgentId: string; bid: Nanos }[] = [];

  for (const reveal of reveals) {
    if (reveal.auctionId !== auctionId) {
      discarded.push({ bidderAgentId: reveal.bidderAgentId, reason: "wrong auction" });
      continue;
    }
    if (reveal.revealedAt > windows.revealClosesAt) {
      discarded.push({ bidderAgentId: reveal.bidderAgentId, reason: "revealed late" });
      continue;
    }
    const commitment = byBidder.get(reveal.bidderAgentId);
    if (!commitment) {
      discarded.push({ bidderAgentId: reveal.bidderAgentId, reason: "no commitment" });
      continue;
    }
    const expected = commitmentHash(auctionId, reveal.bidderAgentId, reveal.bid, reveal.salt);
    if (expected !== commitment.commitmentHash) {
      discarded.push({ bidderAgentId: reveal.bidderAgentId, reason: "commitment mismatch" });
      continue;
    }
    if (reveal.bid <= 0n || reveal.bid > reserve) {
      discarded.push({ bidderAgentId: reveal.bidderAgentId, reason: "bid outside reserve" });
      continue;
    }
    valid.push({ bidderAgentId: reveal.bidderAgentId, bid: reveal.bid });
  }

  valid.sort((a, b) =>
    a.bid === b.bid ? (a.bidderAgentId < b.bidderAgentId ? -1 : 1) : a.bid < b.bid ? -1 : 1,
  );

  const winner = valid[0];
  if (!winner) {
    return fail(
      violation("AUCTION_COMMIT_MISMATCH", "no valid reveals; auction produced no winner", {
        auctionId,
        discarded: discarded.length,
      }),
    );
  }

  return ok({
    auctionId,
    winnerAgentId: winner.bidderAgentId,
    winningBid: winner.bid,
    runnerUpBid: valid[1]?.bid ?? null,
    validReveals: valid.length,
    discardedReveals: discarded,
  });
}
