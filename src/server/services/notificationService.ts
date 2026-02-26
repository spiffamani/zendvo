import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type NotificationType =
    | "gift_sent"
    | "gift_received"
    | "gift_confirmed"
    | "gift_waiting"
    | "gift_failed";

interface CreateNotificationParams {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
}

export async function createNotification(params: CreateNotificationParams) {
    const { userId, type, title, message, metadata } = params;

    return prisma.notification.create({
        data: {
            userId,
            type,
            title,
            message,
            metadata: metadata ? JSON.stringify(metadata) : null,
        },
    });
}

export async function notifyGiftCompleted(
    senderId: string,
    recipientId: string,
    amount: number,
    currency: string,
    transactionId: string,
) {
    const senderNotification = createNotification({
        userId: senderId,
        type: "gift_sent",
        title: "Gift Sent Successfully",
        message: `Your gift of ${amount} ${currency} has been sent successfully.`,
        metadata: { transactionId, amount, currency, recipientId },
    });

    const recipientNotification = createNotification({
        userId: recipientId,
        type: "gift_received",
        title: "You Received a Gift!",
        message: `You've received a gift of ${amount} ${currency}!`,
        metadata: { transactionId, amount, currency, senderId },
    });

    return Promise.all([senderNotification, recipientNotification]);
}

export async function notifyGiftConfirmed(
    senderId: string | null,
    recipientId: string,
    amount: number,
    currency: string,
    shareLink: string,
    unlocksAt?: Date,
) {
    const notifications = [];

    // Notify sender if authenticated
    if (senderId) {
        notifications.push(
            createNotification({
                userId: senderId,
                type: "gift_confirmed",
                title: "Gift Confirmed and Ready to Share",
                message: `Your gift of ${amount} ${currency} has been confirmed. Share it with others!`,
                metadata: { shareLink, amount, currency, recipientId },
            }),
        );
    }

    // Notify recipient
    const unlockText = unlocksAt
        ? `Unlocks on ${new Date(unlocksAt).toLocaleDateString()}`
        : "Available now";

    notifications.push(
        createNotification({
            userId: recipientId,
            type: "gift_waiting",
            title: "A Gift is Waiting for You",
            message: `You've received a gift of ${amount} ${currency}. ${unlockText}`,
            metadata: { shareLink, amount, currency, unlocksAt: unlocksAt?.toISOString() },
        }),
    );

    return Promise.all(notifications);
}
