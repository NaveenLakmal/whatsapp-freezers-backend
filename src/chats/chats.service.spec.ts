jest.mock('../whatsapp/whatsapp.service', () => ({
  WhatsAppService: {
    formatJidFallback: (jid: string) => jid.replace(/@s\.whatsapp\.net$/, '').replace(/@.*$/, ''),
  },
  NameSource: {
    PHONE_CONTACT: 'phone_contact',
    GROUP_SUBJECT: 'group_subject',
    WHATSAPP_PUSHNAME: 'whatsapp_pushname',
    JID_FALLBACK: 'jid_fallback',
  },
}));

import { ChatsService } from './chats.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

describe('ChatsService - Contact Name Resolution', () => {
  let chatsService: ChatsService;
  let mockPrisma: any;
  let mockWhatsApp: any;

  beforeEach(() => {
    mockPrisma = {
      chat: {
        findMany: jest.fn(),
      },
      contact: {
        findMany: jest.fn(),
      },
    };
    mockWhatsApp = {};
    chatsService = new ChatsService(mockPrisma as PrismaService, mockWhatsApp as WhatsAppService);
  });

  it('prioritizes phone-saved contact name (phone_contact) over WhatsApp self-set pushName', async () => {
    mockPrisma.chat.findMany.mockResolvedValue([
      {
        id: '94771234567@s.whatsapp.net',
        name: null,
        unreadCount: 0,
        lastMessageAt: new Date(),
        _count: { messages: 5 },
      },
    ]);

    mockPrisma.contact.findMany.mockResolvedValue([
      {
        jid: '94771234567@s.whatsapp.net',
        name: 'My Phone Saved Name',
        pushName: 'Self Chosen PushName',
        notify: 'Self Chosen PushName',
        imgUrl: 'https://example.com/avatar.jpg',
        nameSource: 'phone_contact',
      },
    ]);

    const result = await chatsService.getChats();
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('My Phone Saved Name');
  });

  it('uses group subject for group chats when available', async () => {
    mockPrisma.chat.findMany.mockResolvedValue([
      {
        id: '120363012345678901@g.us',
        name: 'Official Group Subject',
        unreadCount: 0,
        lastMessageAt: new Date(),
        _count: { messages: 10 },
      },
    ]);

    mockPrisma.contact.findMany.mockResolvedValue([
      {
        jid: '120363012345678901@g.us',
        name: 'Official Group Subject',
        pushName: null,
        notify: null,
        imgUrl: null,
        nameSource: 'group_subject',
      },
    ]);

    const result = await chatsService.getChats();
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('Official Group Subject');
  });

  it('falls back to self-set WhatsApp pushName / notify when no phone contact name exists', async () => {
    mockPrisma.chat.findMany.mockResolvedValue([
      {
        id: '94779999999@s.whatsapp.net',
        name: null,
        unreadCount: 0,
        lastMessageAt: new Date(),
        _count: { messages: 2 },
      },
    ]);

    mockPrisma.contact.findMany.mockResolvedValue([
      {
        jid: '94779999999@s.whatsapp.net',
        name: null,
        pushName: 'Unknown Sender PushName',
        notify: 'Unknown Sender PushName',
        imgUrl: null,
        nameSource: 'whatsapp_pushname',
      },
    ]);

    const result = await chatsService.getChats();
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('Unknown Sender PushName');
  });

  it('falls back to formatted JID number when no contact name or pushName exists', async () => {
    mockPrisma.chat.findMany.mockResolvedValue([
      {
        id: '94789418306@s.whatsapp.net',
        name: null,
        unreadCount: 0,
        lastMessageAt: new Date(),
        _count: { messages: 1 },
      },
    ]);

    mockPrisma.contact.findMany.mockResolvedValue([]);

    const result = await chatsService.getChats();
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe('94789418306');
  });
});
