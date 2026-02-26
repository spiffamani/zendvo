import { NextRequest } from "next/server";
import { POST } from "@/app/api/gifts/public/[giftId]/confirm/route";
import { prisma } from "@/lib/prisma";

// Mock prisma
jest.mock("@/lib/prisma", () => ({
    prisma: {
        gift: {
            findUnique: jest.fn(),
        },
        wallet: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        $transaction: jest.fn(),
    },
}));

// Mock services
jest.mock("@/server/services/transactionService", () => ({
    processGiftTransaction: jest.fn(() => Promise.resolve("txn_mock-uuid-1234")),
}));

jest.mock("@/server/services/notificationService", () => ({
    notifyGiftConfirmed: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/server/services/emailService", () => ({
    sendGiftCompletionToSender: jest.fn(() => Promise.resolve({ success: true })),
    sendGiftNotificationToRecipient: jest.fn(() => Promise.resolve({ success: true })),
}));

// Mock tokens
jest.mock("@/lib/tokens", () => ({
    generateShareLinkToken: jest.fn(() => "mock-share-token-1234"),
}));

const mockGift = {
    id: "gift-123",
    senderId: "sender-123",
    recipientId: "recipient-456",
    amount: 100,
    currency: "USD",
    status: "pending_review",
    transactionId: null,
    message: "Happy Birthday!",
    template: "birthday",
    senderName: "John Sender",
    senderEmail: "sender@example.com",
    shareLink: null,
    shareLinkToken: null,
    completedAt: null,
    unlockDatetime: null,
    sender: { id: "sender-123", name: "John Sender", email: "sender@example.com" },
    recipient: {
        id: "recipient-456",
        name: "Jane Recipient",
        email: "recipient@example.com",
    },
};

function makeRequest(giftId: string) {
    const request = new NextRequest(
        `http://localhost/api/gifts/public/${giftId}/confirm`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
        },
    );

    return request;
}

describe("POST /api/gifts/public/:giftId/confirm", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("should return 200 with status 'completed' and shareLink on success", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue(mockGift);
        (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
            const result = await fn({
                gift: {
                    update: jest.fn(),
                },
            });
            return result;
        });

        const request = makeRequest("gift-123");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.status).toBe("completed");
        expect(data.shareLink).toBe("/gift/mock-share-token-1234");
        expect(data.transactionId).toBe("txn_mock-uuid-1234");
    });

    it("should return 404 if gift does not exist", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue(null);

        const request = makeRequest("nonexistent-gift");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "nonexistent-gift" }),
        });
        const data = await response.json();

        expect(response.status).toBe(404);
        expect(data.success).toBe(false);
        expect(data.error).toBe("Gift not found");
    });

    it("should return 409 if gift has already been confirmed (idempotency)", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue({
            ...mockGift,
            status: "completed",
        });

        const request = makeRequest("gift-123");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });
        const data = await response.json();

        expect(response.status).toBe(409);
        expect(data.success).toBe(false);
        expect(data.error).toBe("Gift has already been confirmed");
        expect(data.status).toBe("completed");
    });

    it("should return 400 if gift status is not pending_review", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue({
            ...mockGift,
            status: "pending_otp",
        });

        const request = makeRequest("gift-123");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.success).toBe(false);
        expect(data.error).toContain("Expected: pending_review");
    });

    it("should perform atomic transaction with gift update and wallet changes", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue(mockGift);

        const mockTxGiftUpdate = jest.fn();

        (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
            await fn({
                gift: {
                    update: mockTxGiftUpdate,
                },
            });
        });

        const request = makeRequest("gift-123");
        await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });

        // Verify $transaction was called
        expect(prisma.$transaction).toHaveBeenCalled();

        // Verify gift was updated with completed status
        expect(mockTxGiftUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "gift-123" },
                data: expect.objectContaining({
                    status: "completed",
                    shareLink: "/gift/mock-share-token-1234",
                    transactionId: "txn_mock-uuid-1234",
                }),
            }),
        );
    });

    it("should send notifications and emails on success", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue(mockGift);
        (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
            await fn({ gift: { update: jest.fn() } });
        });

        const request = makeRequest("gift-123");
        await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });

        const { notifyGiftConfirmed } = jest.requireMock("@/server/services/notificationService");
        const { sendGiftCompletionToSender, sendGiftNotificationToRecipient } = jest.requireMock("@/server/services/emailService");

        // Verify notifications were created
        expect(notifyGiftConfirmed).toHaveBeenCalledWith(
            "sender-123",
            "recipient-456",
            100,
            "USD",
            "/gift/mock-share-token-1234",
            null,
        );

        // Verify sender email was sent
        expect(sendGiftCompletionToSender).toHaveBeenCalledWith(
            "sender@example.com",
            "John Sender",
            "/gift/mock-share-token-1234",
            100,
            "USD",
            "Jane Recipient",
        );

        // Verify recipient email was sent
        expect(sendGiftNotificationToRecipient).toHaveBeenCalledWith(
            "recipient@example.com",
            "Jane Recipient",
            "John Sender",
            100,
            "USD",
            null,
        );
    });

    it("should return 422 if insufficient balance", async () => {
        (prisma.gift.findUnique as jest.Mock).mockResolvedValue(mockGift);

        const { processGiftTransaction } = jest.requireMock("@/server/services/transactionService");
        processGiftTransaction.mockRejectedValue(new Error("Insufficient balance"));

        (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => {
            try {
                await fn({ gift: { update: jest.fn() } });
            } catch (err) {
                throw err;
            }
        });

        const request = makeRequest("gift-123");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });
        const data = await response.json();

        expect(response.status).toBe(422);
        expect(data.success).toBe(false);
        expect(data.error).toContain("Insufficient balance");
    });

    it("should return 500 on internal server error", async () => {
        (prisma.gift.findUnique as jest.Mock).mockRejectedValue(
            new Error("Database connection failed"),
        );

        const request = makeRequest("gift-123");
        const response = await POST(request, {
            params: Promise.resolve({ giftId: "gift-123" }),
        });
        const data = await response.json();

        expect(response.status).toBe(500);
        expect(data.success).toBe(false);
        expect(data.error).toBe("Internal server error");
    });
});
