import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareLinkToken } from "@/lib/tokens";
import { processGiftTransaction } from "@/server/services/transactionService";
import { notifyGiftConfirmed } from "@/server/services/notificationService";
import {
  sendGiftCompletionToSender,
  sendGiftNotificationToRecipient,
} from "@/server/services/emailService";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ giftId: string }> },
) {
  try {
    const { giftId } = await params;

    // Fetch the gift with relationships
    const gift = await prisma.gift.findUnique({
      where: { id: giftId },
      include: {
        sender: {
          select: { id: true, name: true, email: true },
        },
        recipient: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Gift not found
    if (!gift) {
      return NextResponse.json(
        { success: false, error: "Gift not found" },
        { status: 404 },
      );
    }

    // Check if gift status is pending_review
    if (gift.status !== "pending_review") {
      // If already completed, return 409 Conflict
      if (gift.status === "completed") {
        return NextResponse.json(
          {
            success: false,
            error: "Gift has already been confirmed",
            status: gift.status,
          },
          { status: 409 },
        );
      }

      // Otherwise, return 400 Bad Request
      return NextResponse.json(
        {
          success: false,
          error: `Gift cannot be confirmed. Current status: ${gift.status}. Expected: pending_review`,
          status: gift.status,
        },
        { status: 400 },
      );
    }

    // Generate unique share link token
    const shareLinkToken = generateShareLinkToken();
    const shareLink = `/gift/${shareLinkToken}`;

    // Process transaction and update gift atomically
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transactionId = await prisma.$transaction(async (tx: any) => {
      // Process the gift transaction (wallet updates)
      const txnId = await processGiftTransaction({
        senderId: gift.senderId,
        recipientId: gift.recipientId,
        amount: gift.amount,
        currency: gift.currency,
      });

      // Update gift status to completed
      await tx.gift.update({
        where: { id: giftId },
        data: {
          status: "completed",
          transactionId: txnId,
          shareLink,
          shareLinkToken,
          completedAt: new Date(),
        },
      });

      return txnId;
    });

    // Create in-app notifications (non-blocking)
    notifyGiftConfirmed(
      gift.senderId,
      gift.recipientId,
      gift.amount,
      gift.currency,
      shareLink,
      gift.unlockDatetime,
    ).catch((err: unknown) => {
      console.error("[GIFT_CONFIRM_NOTIFICATION_ERROR]", err);
    });

    // Send confirmation email to sender (non-blocking)
    if (gift.senderId && gift.sender) {
      sendGiftCompletionToSender(
        gift.sender.email,
        gift.sender.name || "Valued Sender",
        shareLink,
        gift.amount,
        gift.currency,
        gift.recipient?.name || "Gift Recipient",
      ).catch((err: unknown) => {
        console.error("[GIFT_CONFIRM_SENDER_EMAIL_ERROR]", err);
      });
    } else if (gift.senderEmail && gift.senderName) {
      // For public gifts (no authenticated sender)
      sendGiftCompletionToSender(
        gift.senderEmail,
        gift.senderName,
        shareLink,
        gift.amount,
        gift.currency,
        gift.recipient?.name || "Gift Recipient",
      ).catch((err: unknown) => {
        console.error("[GIFT_CONFIRM_PUBLIC_SENDER_EMAIL_ERROR]", err);
      });
    }

    // Send notification email to recipient (non-blocking)
    if (gift.recipient) {
      sendGiftNotificationToRecipient(
        gift.recipient.email,
        gift.recipient.name || "Valued Recipient",
        gift.senderName || (gift.sender?.name ?? "Someone"),
        gift.amount,
        gift.currency,
        gift.unlockDatetime,
      ).catch((err: unknown) => {
        console.error("[GIFT_CONFIRM_RECIPIENT_EMAIL_ERROR]", err);
      });
    }

    return NextResponse.json(
      {
        success: true,
        status: "completed",
        shareLink,
        transactionId,
        message: "Gift confirmed successfully",
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[GIFT_CONFIRM_ERROR]", error);

    if (error instanceof Error) {
      if (error.message.includes("Insufficient balance")) {
        return NextResponse.json(
          {
            success: false,
            error: "Insufficient balance to send gift",
          },
          { status: 422 },
        );
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 },
    );
  }
}
