import { Keyboard, InlineKeyboard, Bot, MemorySessionStorage, session, webhookCallback } from 'grammy';
import { Menu, MenuRange } from 'grammy_menu';
import { ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup } from 'grammy_types';
import { type ChatMember } from 'grammy-types';
import { createHash } from 'hash';
import { limit } from 'grammy_ratelimiter';
import { chatMembers } from 'grammy_chat_members';
import { hydrateFiles } from 'grammy_files';
import { hydrateApi, hydrateContext } from 'grammy_hydrate';
import { conversations, createConversation } from 'grammy_conversations';
import { Fluent, useFluent } from 'grammyfluent';
import { BotWorker, distribute, run } from 'grammy_runner';
import { SessionInit, SessionSave, BotContext, BotConversation, getLocale, setLocale, syncLocale } from './context.ts';
import { supabaseClient, supabaseCreateStorage } from '$lib/supabase.ts';
import { getFiles, uploadFile } from '$lib/bucket.ts';
import { isNumeric } from '$lib/utils.ts';
import { locales } from '$lib/locales.ts';
import type { Lang, UserData } from '$lib/types.ts';

import ENV from '$lib/vars.ts';
const { DEBUG, TELEGRAM_BOT_SECRET, TELEGRAM_BOT_NAME, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_WEBAPP, ADMIN_IDS, DEFAULT_LANG = 'en' } = ENV;

console.info('TELEGRAM_BOT_NAME:', TELEGRAM_BOT_NAME, 'ADMIN_IDS:', ADMIN_IDS, 'DEFAULT_LANG:', DEFAULT_LANG);

type InlineButton = {
  type: string;
  label: string;
  action: string;
  row?: boolean;
};
//type ButtonArray = KeyboardButton[];
//type ButtonMatrix = ButtonArray[];

const makeKeyboardMarkup = (keyboard: ButtonMatrix, one_time_keyboard: boolean = true, is_persistent: boolean = false): ReplyKeyboardMarkup => { keyboard, one_time_keyboard, is_persistent };
const removeKeyboardMarkup = (remove_keyboard: boolean = true): ReplyKeyboardMarkup => { remove_keyboard };
const makeInlineKeyboardMarkup = (inline_keyboard: ButtonMatrix): InlineKeyboardMarkup => { inline_keyboard };
const makeKeyboardButton = (qry: string = '', text: string = TELEGRAM_BOT_NAME): KeyboardButton => {
  const url = `${TELEGRAM_BOT_WEBAPP}${qry}`;
  return {
    text,
    web_app: { url }
  };
};

const keyboardButton: KeyboardButton = makeKeyboardButton();
const keyboardMarkup: ReplyKeyboardMarkup = makeKeyboardMarkup([[keyboardButton]]);

const makeInlineKeyboard = (inlineButtons: InlineButton[]): InlineKeyboard => {
  const inlineKeyboard = new InlineKeyboard();
  inlineButtons.forEach(el => {
    if (el.type in inlineKeyboard) inlineKeyboard[el.type](el.label, el.action);
    if (el.row) inlineKeyboard.row();
  });
  return inlineKeyboard;
};

const chatInlineKeyboard = async (ctx: BotContext, action: string = 'update', deleteMessage: boolean = false): Promise<void> => {
  const webURL = `https://t.me/${TELEGRAM_BOT_NAME}?start=${action}_${ctx.chat.id}`
  const inlineButtons: InlineButton[] = [
    //{ type: 'text', label: ctx.t('exit'), action: '/exit' },
    { type: 'url', label: ctx.t(action), action: webURL },
  ];
  const inlineKeyboard = makeInlineKeyboard(inlineButtons);
  await ctx.reply(ctx.t('button'), { reply_markup: inlineKeyboard, reply_to_message_id: ctx.msg.message_id });
  if (deleteMessage && ctx.msg?.message_id) await bot.api.deleteMessage(ctx.chat.id, ctx.msg.message_id);
};

const pmInlineKeyboard = async (ctx: BotContext, deleteMessage: boolean = false): Promise<void> => {
  const user: UserData = ctx.session.user;
  if (!!!user?.id) return;

  const webQry = `?uid=${user.uid}&lang=${user.lang}`;
  const webApp = `${TELEGRAM_BOT_WEBAPP}${webQry}`;
  const webURL = DEBUG ? `http://127.0.0.1:3003/${webQry}` : webApp;

  const inlineButtons: InlineButton[] = [
    { type: 'webApp', label: ctx.t('webapp'), action: `${webApp}&mode=app` },
    { type: 'url', label: ctx.t('website'), action: webURL },
  ];

  const inlineKeyboard = makeInlineKeyboard(inlineButtons);

  //await ctx.reply('Hello!', { reply_markup: removeKeyboardMarkup() });
  await ctx.reply(ctx.t('menu'), { reply_markup: inlineKeyboard });
  if (deleteMessage && ctx.msg?.message_id) await bot.api.deleteMessage(ctx.chat.id, ctx.msg.message_id);
};

export const uploadBotFile = async (ctx: BotContext): Promise<void> => {
	// Prepare the file for download.
	const { file_id, file_unique_id, file_size, file_path, getUrl } = await ctx.getFile();
	const url = await getUrl();
	const fileBuffer = await (await (await fetch(url)).blob()).arrayBuffer();
	if (fileBuffer) {
		const hash = createHash('md5').update(fileBuffer).toString();
		const [ dir, filename ] = file_path.split('/');
		const { files, error } = await getFiles(dir, hash);
		if (!error && files.length>0) {
			ctx.reply(ctx.t('file_already'));
		} else {
			const { data: upload_data, error: upload_error } = await uploadFile(`${dir}/${hash}-${filename}`, fileBuffer);
			if (!upload_error) {
				const { files: get_files, error: get_error } = await getFiles(dir, hash);
				if (!get_error && get_files.length>0) {
					const file = {
						uid: get_files[0].id,
						name: get_files[0].name,
						file_id,
						file_unique_id,
						file_path,
						file_size,
					}
					const { data: upsert_data, error: upsert_error } = await supabaseClient.from('files').upsert(file).select();
					if (DEBUG) console.log(upsert_data);
				}
				ctx.reply(ctx.t('file_uploaded'));
			} else {
				ctx.reply(ctx.t('file_notuploaded'));
			}
		}
	} else {
    ctx.reply(ctx.t('file_notuploaded'));
  }
};

const registerHelper = async (conversation: BotConversation, ctx: BotContext): Promise<void> => {
  await ctx.reply('How many favorite movies do you have?');
  const countCtx = await conversation.waitFor(':text');
  if (DEBUG) console.log('register count:', countCtx.msg.text);
  if (!isNumeric(countCtx.msg.text)) return;
  const count: number = Number(countCtx.msg.text);
  if (count<1) return;
  const movies: string[] = [];
  for (let i = 0; i < count; i++) {
    await ctx.reply(`Tell me number ${i + 1}!`);
    const titleCtx = await conversation.waitFor(':text');
    movies.push(titleCtx.msg.text);
  }
  if (movies.length>0) {
    await ctx.reply('Here is a better ranking!');
    movies.sort();
    await ctx.reply(movies.map((m, i) => `${i + 1}. ${m}`).join('\n'));
  }
  return;
};

const unregisterHelper = async (conversation: BotConversation, ctx: BotContext): Promise<void> => {
  ctx.reply('unregisterHelper');
};

const updateChat = async (conversation: BotConversation, ctx: BotContext): Promise<void> => {
  if (DEBUG) console.log(ctx.session.data);
  const chat = ctx.session.data?.chat;
  if (!chat || (!chat?.admins?.includes(ctx.from.id) && chat?.creator !== ctx.from.id)) {
    await ctx.reply('Ha-ha!');
    return;
  }
  const chatInfo = {
    invite: '',
    country: '',
    state: '',
    city: ''
  };

  await ctx.reply(`You have chosen chat "${chat.title}" with invite link:
  ${chat.invite}
  Press /exit if it is the wrong choice
  `);

  await ctx.reply('Chat invite?');
  let convCtx = await conversation.waitFor(':text');
  if (convCtx.msg.text.startsWith('/exit')) {
    await ctx.reply('Bye!');
    return;
  };
  if (convCtx.msg.text.startsWith('http')) {
    chat.invite = convCtx.msg.text;
    chatInfo.invite = convCtx.msg.text;
  }
  if (!chat.invite) {
    await ctx.reply(ctx.t('update_invite'));
    return;
  }

  await ctx.reply('Chat country?');
  convCtx = await conversation.waitFor(':text');
  if (convCtx.msg.text.startsWith('/exit')) {
    await ctx.reply('Bye!');
    return;
  };
  if (convCtx.msg.text.length===2) {
    const { data: countryData } = await supabaseClient.from('countries').select('*').eq('code', convCtx.msg.text.toUpperCase());
    if (countryData?.length>0) {
      chat.country = countryData[0].id;
      chatInfo.country = countryData[0].name;
      await ctx.reply('Country chosen: '+chatInfo.country);
    }
  }
  if (!chat.country) {
    await ctx.reply(ctx.t('update_country'));
    return;
  }

  await ctx.reply('Chat state? Send "-" (minus) if none.');
  convCtx = await conversation.waitFor(':text');
  if (convCtx.msg.text.startsWith('/exit')) {
    await ctx.reply('Bye!');
    return;
  };
  if (convCtx.msg.text.length>0 && convCtx.msg.text!=='-') {
    const { data: stateData } = await supabaseClient.from('states').select('*').match({ country: chat.country, 'code': convCtx.msg.text });
    if (stateData?.length>0) {
      chat.state = stateData[0].id;
      chatInfo.state = stateData[0].name;
      await ctx.reply('State chosen: '+chatInfo.state);
    }
  }

  await ctx.reply('Chat city? Send "-" (minus) if none.');
  convCtx = await conversation.waitFor(':text');
  if (convCtx.msg.text.startsWith('/exit')) {
    await ctx.reply('Bye!');
    return;
  };
  if (convCtx.msg.text.length>0 && convCtx.msg.text!='-') {
    const { data: cityData } = await supabaseClient.from('cities').select('*').eq('country', chat.country).ilike('name', '%'+convCtx.msg.text+'%');
    if (cityData?.length>0) {
      chat.city = cityData[0].id;
      chatInfo.city = cityData[0].name;
      await ctx.reply('City chosen: '+chatInfo.city);
    }
  }

  await ctx.reply(`You have added:
    invite: ${chatInfo.invite}
    country: ${chatInfo.country}
    state: ${chatInfo.state}
    city: ${chatInfo.city}
    Send "+" (plus) if this is correct.
  `);
  convCtx = await conversation.waitFor(':text');
  if (convCtx.msg.text==='+') {
    const { data, error } = await supabaseClient.from('chats').update({ updated_at: new Date(), ...chat }).eq('id', chat.id).select();
    if (DEBUG) console.log('updateChat chat update:', update);
    ctx.session.data = {};
    if (!error && data.length>0)
      await ctx.reply('Chat info updated!');
    else
      await ctx.reply('Error updating chat info!');
  } else {
    await ctx.reply('Bye!');
  }
  return;
};


export const initBot = async () => {
  const bot = new Bot<BotContext>(TELEGRAM_BOT_TOKEN);

  const notifyAdmins = (text = `The @${TELEGRAM_BOT_NAME} <b>bot initialized</b>!`, options = { parse_mode: 'HTML' }) => {
    ADMIN_IDS.forEach(aid => {
      bot.api.sendMessage(aid, text, options);
    });
  };

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    console.error('Error in request:', err.error);
  });

  const memorySessionAdapter = new MemorySessionStorage<ChatMember>();

  const fluent = new Fluent();
  for (let lang of Object.keys(locales)) {
    const source = Object.keys(locales[lang]).map(cmd=>`${cmd} = ${locales[lang][cmd]}`).join('\n');
    await fluent.addTranslation({
      locales: lang,
      source,
      // All the aspects of Fluent are highly configurable:
      bundleOptions: {
        // Use this option to avoid invisible characters around placeables.
        useIsolating: false,
      },
    });
  }

  bot.api.config.use(hydrateApi());
  bot.api.config.use(hydrateFiles(TELEGRAM_BOT_TOKEN));
  bot.use(hydrateContext());
  bot.use(chatMembers(memorySessionAdapter));
  bot.use(session({ initial: SessionInit, storage: supabaseCreateStorage() })); // freeStorage<Session>(bot.token);
  bot.use(SessionSave);
  bot.use(useFluent({
    fluent,
    localeNegotiator: (ctx: BotContext) => ctx.session['__language_code'] || ctx.session.user?.lang,
  }));
  bot.use(limit());

  bot.use(conversations());
  bot.use(createConversation(registerHelper, 'register'));
  bot.use(createConversation(unregisterHelper, 'unregister'));
  bot.use(createConversation(updateChat, 'update'));
  //bot.errorBoundary((err) => console.error('App threw an error!', err),createConversation(register));

  // Exit conversations when the inline keyboard's `exit` button is pressed.
  bot.callbackQuery('exit', async (ctx) => {
    await ctx.conversation.exit();
    await ctx.answerCallbackQuery();
  });
  // replying /reg command in
  bot.command('reg', async (ctx: BotContext) => {
    if (ctx.chat.id!==ctx.from.id) {
      //await ctx.reply(ctx.t('reg', { bot_name: TELEGRAM_BOT_NAME, chat_id: String(ctx.chat.id) }), { reply_to_message_id: ctx.msg.message_id });
      //if (ctx.msg?.message_id) await bot.api.deleteMessage(ctx.chat.id, ctx.msg.message_id);
      await chatInlineKeyboard(ctx, 'register');
    } else
      await ctx.conversation.enter('register');
  });
  // replying /upd command in
  bot.command('upd', async (ctx: BotContext) => {
    if (ctx.chat.id!==ctx.from.id) {
      await chatInlineKeyboard(ctx, 'update');
    } else
      await ctx.conversation.enter('update');
  });

  // Only handle commands in private chats.
  const pm = bot.chatType('private');
  pm.command('menu', (ctx: BotContext) => pmInlineKeyboard(ctx));
  pm.command('help', (ctx: BotContext) => ctx.reply(ctx.t('help', { locales: Object.keys(locales).join('|') })));
  pm.command('exit', async (ctx: BotContext) => (await ctx.conversation.exit()));
  pm.command('register', async (ctx: BotContext) => (await ctx.conversation.enter('register')));
  pm.command('unregister', async (ctx: BotContext) => (await ctx.conversation.enter('unregister')));
  pm.command('update', async (ctx: BotContext) => (await ctx.conversation.enter('update')));
  pm.command('start', async (ctx: BotContext) => {
    const cmd = ctx.match.trim().toLowerCase();
    const cmds = cmd.split('_').filter(el=>!!el);
    if (DEBUG) console.log('/start cmds:', cmds);
    if (cmds.length>1) {
      // check membership
      const action = cmds[0].trim();
      const chat_id = Number(cmds[1].trim());
      const { data, error } = await supabaseClient.from('chats').select('*').eq('id', chat_id);
      const chat = data && data[0];
      if (DEBUG) console.log('action:', action, '/start chat:', chat);
      if (action==='register' && (chat?.creator == ctx.session.user.id || [].concat(chat?.admins,chat?.members).includes(ctx.session.user.id))) {
        // start register conversation
        ctx.session.data = { chat };
        await ctx.conversation.enter(action);
      } else if (action==='update' && (chat?.creator == ctx.session.user.id || chat?.admins.includes(ctx.session.user.id))) {
        // start update conversation
        ctx.session.data = { chat };
        await ctx.conversation.enter(action);
      } else if (action==='register' && chat) {
        ctx.reply(ctx.t('member', { chat_title: chat.title, chat_id: String(chat.id) }));
      } else {
        ctx.reply(ctx.t('start'));
      }
    } else {
      ctx.reply(ctx.t('start'));
    }
  });
  pm.command('lang', async (ctx: BotContext) => {
    if (!!!ctx.session.user?.id || Number(ctx.chat.id)<1) return;
    const lang: Lang = ctx.match.trim().toLowerCase();
    if (!!lang) await setLocale(ctx, lang);
    ctx.reply(ctx.t('start'));
  });
  pm.command('ping', (ctx: BotContext) => {
    ctx.reply(`Pong!
    ${new Date()}
    ${Date.now()}
    `);
  });

  pm.hears(/files*(.+)?/, async (ctx: BotContext, dir = 'content') => {
    if (ADMIN_IDS.includes(ctx.msg.from.id)) {
      const [cmd, dir] = ctx.match;
      const { files, error } = await getFiles(dir && dir.trim().toLowerCase());
      ctx.reply(`${JSON.stringify(files,null,2)}`);
    }
  });

  // Getting files
  pm.on([":file", ":media", ":voice", ":audio", ":video", ":animation"], async (ctx: BotContext) => {
    if (ADMIN_IDS.includes(ctx.session?.user?.id)) {
      await uploadBotFile(ctx);
    } else {
      ctx.reply(ctx.t('start'));
    }
  });

  pm.on('message:text', (ctx: BotContext) => {
    ctx.reply(ctx.t('start'));
    if (ADMIN_IDS.includes(ctx.session?.user?.id)) {
      ctx.reply(`${JSON.stringify(ctx.session,null,2)}`);
    }
  });
  pm.on('message:photo', (ctx: BotContext) => ctx.reply(ctx.t('start')));
  pm.on('edited_message', (ctx: BotContext) => ctx.reply('Ha! Gotcha! You just edited this!', { reply_to_message_id: ctx.editedMessage.message_id }));

  notifyAdmins();

  return {
    bot,
    run,
    handleUpdate: webhookCallback(bot, 'std/http'),
  };
};

/*

file: {
  file_id: "CQACAgIAAxkBAAIEX2RuIUuWTQcNM7rsq1b7fYpQtvZqAAL4KwACeBtwS5CiUh9-CQzKLwQ",
  file_unique_id: "AgAD-CsAAngbcEs",
  file_size: 2837325,
  file_path: "music/file_0.mp3",
  getUrl: [Function: getUrl],
  download: [AsyncFunction: download]
}

uploadFile: { path: "music/b2d5dd67de1feb2500c771183ee735aa-file_0.mp3" }

getFiles: [
  {
    name: "b2d5dd67de1feb2500c771183ee735aa-file_0.mp3",
    id: "3afdfcfa-9884-4836-a066-e4a8089e8396",
    updated_at: "2023-05-24T14:30:07.448795+00:00",
    created_at: "2023-05-24T14:30:07.212706+00:00",
    last_accessed_at: "2023-05-24T14:30:07.212706+00:00",
    metadata: {
      eTag: '"b2d5dd67de1feb2500c771183ee735aa"',
      size: 2837325,
      mimetype: "text/plain;charset=UTF-8",
      cacheControl: "max-age=3600",
      lastModified: "2023-05-24T14:30:08.000Z",
      contentLength: 2837325,
      httpStatusCode: 200
    }
  }
]



  bot.inlineQuery(/best*(.+)?/, async (ctx) => {
    await ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: "grammy-website",
          title: "grammY",
          input_message_content: {
            message_text:
  "<b>grammY</b> is the best way to create your own Telegram bots. \
  They even have a pretty website! 👇",
            parse_mode: "HTML",
          },
          reply_markup: new InlineKeyboard().url(
            "grammY website",
            "https://grammy.dev/",
          ),
          url: "https://grammy.dev/",
          description: "The Telegram Bot Framework.",
        },
      ],
      { cache_time: 30 * 24 * 3600 }, // one month in seconds
    );
  });
  // Return empty result list for other queries.
  bot.on('inline_query', (ctx) => ctx.answerInlineQuery([]));

  bot.hears('salut', (ctx) => ctx.reply('salut'));
  bot.hears('hello', (ctx) => ctx.reply('hello'));
  bot.hears('hola', (ctx) => ctx.reply('hola'));

*/
