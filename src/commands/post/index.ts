import questions from './questions';
import { createEmbed, createMarkdownCodeBlock } from '../../utils/discordTools';
import { cache } from '../../spam_filter';
import {
  Message,
  CollectorFilter,
  TextChannel,
  DMChannel,
  NewsChannel,
  Guild,
  GuildChannel,
  MessageEmbed,
} from 'discord.js';
import {
  AWAIT_MESSAGE_TIMEOUT,
  MOD_CHANNEL,
  JOB_POSTINGS_CHANNEL,
  POST_LIMITER_IN_HOURS,
  MINIMAL_COMPENSATION,
} from './env';

type OutputField = {
  name: string;
  value: string;
  inline: boolean;
};

type Metadata = {
  username: string;
  discriminator: string;
  msgID: string;
};

type Channel = TextChannel | NewsChannel | DMChannel;

type Answers = Map<string, string>;

type CacheEntry = {
  key: string;
  value: Date;
};

interface TargetChannel extends GuildChannel {
  send?: (
    message: string | { embed: Partial<MessageEmbed> }
  ) => Promise<Message>;
}

enum Days {
  Sunday = 0,
  Monday,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
  Saturday,
}

enum Months {
  January = 0,
  February,
  March,
  April,
  May,
  June,
  July,
  August,
  September,
  October,
  November,
  December,
}

const getCurrentDate = () => {
  const date = new Date();

  return `${Days[date.getDay()]}, ${
    Months[date.getMonth()]
  } ${date.getDate()}, ${date.getFullYear()}`;
};

const trimContent = (str: string) => str.trim();

const capitalize = (str: string) =>
  `${str[0].toUpperCase()}${str.substring(1).toLowerCase()}`;

const getTargetChannel = (guild: Guild, name: string): TargetChannel =>
  guild.channels.cache.find(({ name: n }) => n === name);

const generateURL = (guildID: string, channelID: string, msgID: string) =>
  `https://discordapp.com/channels/${guildID}/${channelID}/${msgID}`;

const getReply = async (channel: Channel, filter: CollectorFilter) => {
  try {
    const res = await channel.awaitMessages(filter, {
      max: 1,
      time: AWAIT_MESSAGE_TIMEOUT,
    });

    const content = trimContent(res.first().content);

    return content.toLowerCase() === 'cancel' ? null : content; // Return false if the user explicitly cancels the form
  } catch {
    channel.send('You have timed out. Please try again.');
  }
};

const sendAlert = (
  guild: Guild,
  channel: Channel,
  userInput: string,
  { username, discriminator, msgID }: Metadata
): void => {
  const targetChannel = getTargetChannel(guild, MOD_CHANNEL);

  if (!targetChannel) {
    console.warn(
      'env.MOD_CHANNEL does not exist on this server - via post.sendAlert'
    );
    return;
  }

  const user = createUserTag(username, discriminator);

  try {
    targetChannel.send(
      createEmbed({
        url: 'https://discord.gg/',
        description:
          'A user tried creating a job post whilst providing invalid compensation.',
        title: 'Alert!',
        footerText: 'Job Posting Module',
        provider: 'spam',
        fields: [
          {
            name: 'User',
            value: user,
            inline: true,
          },
          {
            name: 'User Input',
            value: createMarkdownCodeBlock(userInput),
            inline: false,
          },
          {
            name: 'Command',
            value: createMarkdownCodeBlock(
              `?ban ${user} Attempting to create a job post with invalid compensation.`
            ),
            inline: false,
          },
          {
            name: 'Message Link',
            value: 'DM channel - not applicable',
            inline: false,
          },
        ],
      })
    );
  } catch (error) {
    console.error('post.sendAlert', error);
  }
};

const generateFields = (answers: Answers): OutputField[] => {
  const response = [];

  for (let [key, value] of answers) {
    if (key === 'compensation')
      value = value.includes('$') ? value : `${value}$`;

    if (key !== 'remote' && value === 'no') {
      value = 'Not provided.'; // If the value is "no", don't print that field
    }

    response.push({
      name: capitalize(key),
      value: createMarkdownCodeBlock(value),
      inline: false,
    });
  }

  return response;
};

const createUserTag = (username: string, discriminator: string) =>
  `@${username}#${discriminator}`;

const createJobPost = async (
  answers: Answers,
  guild: Guild,
  channelID: string,
  { username, discriminator, msgID }: Metadata
) => {
  const targetChannel = getTargetChannel(guild, JOB_POSTINGS_CHANNEL);

  if (!targetChannel) {
    console.warn(
      'env.JOB_POSTINGS_CHANNEL does not exist on this server - via post.createJobPost'
    );
    return;
  }

  const user = createUserTag(username, discriminator);
  const url = generateURL(guild.id, channelID, msgID);

  try {
    const msg = await targetChannel.send(
      createEmbed({
        url,
        description: `A user has created a new job post!`,
        title: 'New Job Posting!',
        footerText: 'Job Posting Module',
        provider: 'spam', // Using the spam provider because we only need the color/icon, which it provides anyway
        fields: [
          {
            name: 'User',
            value: user,
            inline: true,
          },
          {
            name: 'Created At',
            value: getCurrentDate(),
            inline: true,
          },
          ...generateFields(answers),
        ],
      })
    );

    return generateURL(guild.id, msg.channel.id, msg.id);
  } catch (error) {
    console.error('post.createJobPost', error);
  }
};

const formAndValidateAnswers = async (
  channel: Channel,
  filter: CollectorFilter,
  guild: Guild,
  send: Function,
  { username, discriminator, msgID }: Metadata
): Promise<Answers> => {
  const answers = new Map();

  // Iterate over questions
  for (const key in questions) {
    // Check if the current question is the location question
    if (key === 'location') {
      // Check if the `isRemote` value has been set to "yes"
      const isRemote = answers.get('remote');
      // If the value is set to "yes", skip this iteration
      if (isRemote.toLowerCase() === 'yes') {
        continue;
      }
    }

    const q = questions[key];
    // Send out the question
    await send(q.body);
    // Await the input
    const reply = await getReply(channel, filter);
    // If the reply is equal to "cancel", cancel the form
    if (!reply) {
      await send('Explicitly cancelled job post form. Exiting.');
      return null;
    }
    // If there is a validation method appended to the question, use it
    if (!q.validate) {
      answers.set(key, reply);
      continue;
    }
    // If the input is not valid, cancel the form and notify the user.
    const isValid = q.validate(reply);
    // Alert the moderators if the compensation is invalid.
    if (key === 'compensation' && !isValid) {
      sendAlert(guild, channel, reply, { username, discriminator, msgID });
    }

    if (!isValid) {
      await send('Invalid input. Cancelling form.');
      return null;
    }
    // Otherwise, store the answer in the output map
    answers.set(key, reply);
  }

  return answers;
};

const generateCacheEntry = (key: string): CacheEntry => ({
  key: `jp-${key}`, // JP stands for Job Posting, for the sake of key differentiation
  value: new Date(),
});

const handleJobPostingRequest = async (msg: Message) => {
  const filter: CollectorFilter = m => m.author.id === msg.author.id;
  const send = (str: string) => msg.author.send(str);

  try {
    const { guild, id: msgID } = msg;
    const { username, discriminator, id } = msg.author;
    // Generate cache entry
    const entry = generateCacheEntry(id);
    // Check if the user has been cached
    const isCached = cache.get(entry.key);

    if (isCached) {
      send(
        'You cannot create a job posting right now. Please try again later.'
      );
      return;
    }
    // Store the post attempt in the cache
    cache.set(entry.key, entry.value, POST_LIMITER_IN_HOURS);
    // Notify the user regarding the rules, and get the channel
    const { channel } = await send(
      `Heads up!
Posts without financial compensation are not allowed.
Also, attempting to create a post with compensation that is lower than \`$${MINIMAL_COMPENSATION}\` is not allowed.
Trying to circumvent these rules in any way will result in a ban.
If you are not willing to continue, type \`cancel\`.
Otherwise, type \`ok\` or anything else to continue.`
    );

    const { id: channelID } = msg.channel;
    const proceed = await getReply(channel, filter);

    if (!proceed) {
      return send('Canceled.');
    }

    const answers = await formAndValidateAnswers(channel, filter, guild, send, {
      username,
      discriminator,
      msgID,
    });

    // Just return if the iteration breaks due to invalid input
    if (!answers) {
      return;
    }

    const url = await createJobPost(answers, guild, channelID, {
      username,
      discriminator,
      msgID,
    });

    // Notify the user that the form is now complete
    await send('Your job posting has been created! - ' + url);
  } catch (error) {
    await msg.reply(
      'Please temporarily enable direct messages as the bot cares about your privacy.'
    );
    console.error('post.handleJobPostingRequest', error);
  }
};

export default handleJobPostingRequest;
