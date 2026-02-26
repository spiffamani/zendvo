import { prisma } from "@/lib/prisma";
import crypto from "crypto";

export interface ProcessGiftTransactionParams {
  senderId: string | null;
  recipientId: string;
  amount: number;
  currency: string;
}

export async function processGiftTransaction(
  params: ProcessGiftTransactionParams,
) {
  const { senderId, recipientId, amount, currency } = params;
  const transactionId = `txn_${crypto.randomUUID()}`;

  // If sender is authenticated, deduct from their wallet
  if (senderId) {
    const senderWallet = await prisma.wallet.findUnique({
      where: {
        userId_currency: {
          userId: senderId,
          currency,
        },
      },
    });

    if (!senderWallet || senderWallet.balance < amount) {
      throw new Error("Insufficient balance");
    }

    // Update sender wallet (deduct)
    await prisma.wallet.update({
      where: {
        userId_currency: {
          userId: senderId,
          currency,
        },
      },
      data: {
        balance: {
          decrement: amount,
        },
      },
    });
  }

  // Upsert recipient wallet (add)
  await prisma.wallet.upsert({
    where: {
      userId_currency: {
        userId: recipientId,
        currency,
      },
    },
    update: {
      balance: {
        increment: amount,
      },
    },
    create: {
      userId: recipientId,
      currency,
      balance: amount,
    },
  });

  return transactionId;
}
