import {RequestHandler, Router} from 'express';
import * as i18n from 'i18n';
import * as kue from 'kue';
import { defaults, difference, get, keyBy } from 'lodash';
import * as moment from 'moment-timezone';
import * as emojis from 'node-emoji';
import * as passport from 'passport';
import {Params, Twitter} from 'twit';
import {format, promisify} from 'util';
import Dao, {UserCategory} from '../dao/dao';
import logger from '../utils/logger';
import {IUnfollowerInfo, Lang} from '../utils/types';

const router = Router();
export default router;

const AUTH_REDIRECT = process.env.AUTH_REDIRECT || 'http://localhost:8080/';

const shouldBeLoggedIn: RequestHandler = (req, res, next) => {
    if (!req.session.passport || !req.session.passport.user) {
        res.status(400);
        return res.json({error: 'you must be logged in to access this endpoint'});
    }
    next();
};

const dao = new Dao();
const queue = kue.createQueue();

router.get('/', (req, res) => res.json({message: 'Unfollow ninja API is up!'}));

router.get('/auth',  passport.authenticate('twitter'), (req, res) => {
    res.redirect(AUTH_REDIRECT);
});

router.get('/infos', shouldBeLoggedIn, (req, res) => {
    const { username, id, photo, dmId, dmPhoto } = req.user;
    if (dmId) {
        dao.getCachedUsername(dmId).then((dmUsername) => {
            res.json( { username, id, photo, dmId, dmUsername, dmPhoto });
        });
    } else {
        res.json( { username, id, photo });
    }
});

router.get('/auth-dm-app', shouldBeLoggedIn, passport.authenticate('twitter-dm', { session: false }), (req, res) => {
    const { username, id, photo, token, tokenSecret } = req.user;
    Promise.all([
        dao.getUserDao(req.session.passport.user.id).setUserParams({
            dmId: id,
            dmPhoto: photo,
            dmToken: token,
            dmTokenSecret: tokenSecret,
        }),
        dao.getUserDao(req.session.passport.user.id).setCategory(UserCategory.enabled),
        dao.addTwittoToCache({id, username}),
    ]).then(
        () => promisify((cb) =>
            queue
                .create('sendWelcomeMessage', {
                    title: `send welcome message to @${username}`,
                    userId: id,
                    username,
                })
                .removeOnComplete(true)
                .save(cb),
        )(),
    ).then(() => res.redirect(AUTH_REDIRECT));
});

router.get('/remove-dm-app', shouldBeLoggedIn, (req, res) => {
    Promise.all([
        dao.getUserDao(req.session.passport.user.id).setCategory(UserCategory.disabled),
        dao.getUserDao(req.session.passport.user.id).setUserParams({
            dmId: null,
            dmPhoto: null,
            dmToken: null,
            dmTokenSecret: null,
        }),
    ]).then(() => res.redirect('/v1/infos'));
});

router.get('/debug/get-unfollowers-since-last-check', shouldBeLoggedIn, (req, res) => {
    getUnfollowersSinceLastCheck(req.session.passport.user.usename, req.session.passport.user.id)
        .then((result) => res.json(result))
        .catch((err) => {
            logger.error(err);
            res.json(err);
        });
});

// from checkFollowers and notifyUsers
async function getUnfollowersSinceLastCheck(username: string, userId: string): Promise<object> {
    const userDao = dao.getUserDao(userId);

    const twit = await userDao.getTwit();

    let requests = 0;
    let cursor = '-1';
    const followers: string[] = [];

    let remainingRequests: number;
    let resetTime: number;
    while (cursor !== '0') {
        if (remainingRequests === 0) {
            return {error: `tweetlimit. Reessayez dans ${resetTime / 60000} minutes`};
        }
        const result: any = await twit.get('followers/ids', {cursor, stringify_ids: true});
        cursor = result.data.next_cursor_str;
        requests++;

        remainingRequests = Number(result.resp.headers['x-rate-limit-remaining']);
        resetTime = Number(result.resp.headers['x-rate-limit-reset']) * 1000;

        followers.push(...result.data.ids);
    }
    return await detectUnfollows(followers, userId);
}

async function detectUnfollows(followers: string[], userId: string): Promise<object> {
    const userDao = dao.getUserDao(userId);

    const formerFollowers: string[] = await userDao.getFollowers() || [];

    const newFollowers = difference(followers, formerFollowers);
    const unfollowers = difference(formerFollowers, followers);

    const recap = format('User %s has %d new followers, and %d unfollowers', userId, newFollowers.length, unfollowers.length);
    logger.debug(recap);

    const unfollowersInfo = await Promise.all(
        unfollowers.map(async (unfollowerId): Promise<IUnfollowerInfo> => {
            return {
                id: unfollowerId,
                followTime: await userDao.getFollowTime(unfollowerId),
                unfollowTime: Number(Date.now()),
                followDetectedTime: await userDao.getFollowDetectedTime(unfollowerId),
            };
        }),
    );

    return await fetchAndGenerateMessages(userId, unfollowersInfo, recap);
}

const MAX_UNFOLLOWERS = 50;

i18n.configure({
    locales: ['en', 'fr'],
    directory: __dirname + '/../../locales',
});

moment.tz.setDefault('Europe/Paris');

async function fetchAndGenerateMessages(userId: string, unfollowersInfo: IUnfollowerInfo[], recap: string) {
    const userDao = dao.getUserDao(userId);
    const twit = await userDao.getTwit();

    const leftovers = unfollowersInfo.splice(MAX_UNFOLLOWERS);

    unfollowersInfo.forEach(u => u.suspended = true);
    const unfollowersIds = unfollowersInfo.map(u => u.id);
    const unfollowersMap = keyBy(unfollowersInfo, 'id');

    // cache twittos and know who's suspended
    const usersLookup = await twit.post('users/lookup', {
        user_id: unfollowersIds.join(','),
        include_entities: false,
    }).catch((): any => ({data: []})) as { data: Twitter.User[] };

    if (!Array.isArray(usersLookup.data)) {
        return {error: usersLookup.data};
    }

    await Promise.all(usersLookup.data.map(user => {
        unfollowersMap[user.id_str].suspended = false;
        unfollowersMap[user.id_str].username = user.screen_name;
    }));

    // know who you're blocking or blocked you
    await Promise.all(unfollowersInfo.map(async unfollower => { // know if we're blocked / if we blocked them
        let errorCode = null;
        const friendship = await twit.get('friendships/show', {target_id: unfollower.id} as Params)
            .catch(async (err: any) => {
                errorCode = get(err, 'twitterReply.errors[0].code', null);
                return {};
            }) as any;
        if (friendship.data && friendship.data.relationship) {
            if (!unfollower.username) {
                const {screen_name} = friendship.data.relationship.target;
                unfollower.username = screen_name;
            }
            const {blocking, blocked_by, following, followed_by} = friendship.data.relationship.source;
            defaults(unfollower, {blocking, blocked_by, following, followed_by});
        }
        if (errorCode !== null) {
            unfollower.friendship_error_code = errorCode;
            if (errorCode === 50) {
                unfollower.suspended = false;
                unfollower.deleted = true;
            }
        }
    }));

    // get missing usernames from the cache
    await Promise.all(unfollowersInfo.map(async unfollower => {
        if (!unfollower.username) {
            const cachedUsername = await dao.getCachedUsername(unfollower.id);
            if (cachedUsername) {
                unfollower.username = cachedUsername;
            }
        }
    }));

    logger.debug('@%s has new unfollowers: %s', userId, JSON.stringify(unfollowersInfo.concat(leftovers)));

    // we remove unfollowers that followed the user < 24h and that "left twitter" (glitches very probably)
    const realUnfollowersInfo = unfollowersInfo.filter(unfollowerInfo => {
        const followDuration = unfollowerInfo.unfollowTime - unfollowerInfo.followDetectedTime;
        return unfollowerInfo.followed_by !== true &&
            !(unfollowerInfo.deleted && followDuration < 24 * 60 * 60 * 1000) &&
            followDuration > 7 * 60 * 1000;
    });

    return {
        recap,
        message: await generateMessage(realUnfollowersInfo, await userDao.getLang(), leftovers.length),
    };
}

async function generateMessage(unfollowersInfo: IUnfollowerInfo[], lang: Lang, nbLeftovers: number): Promise<string> {
    i18n.setLocale(lang);
    const messages: string[] = unfollowersInfo.map((unfollower) => {
        const username = unfollower.username ? '@' + unfollower.username : i18n.__('one of you followers');

        let action;
        if (unfollower.suspended) {
            const emoji = emojis.get('see_no_evil');
            action = i18n.__('{{username}} has been suspended {{emoji}}.', { username, emoji });
        } else if (unfollower.deleted) {
            const emoji = emojis.get('see_no_evil');
            action = i18n.__('{{username}} has left Twitter {{emoji}}.', { username, emoji });
        } else if (unfollower.blocked_by) {
            const emoji = emojis.get('no_entry');
            action = i18n.__('{{username}} blocked you {{emoji}}.', { username, emoji });
        } else if (unfollower.blocking) {
            const emoji = emojis.get('poop').repeat(3);
            action = i18n.__('You blocked {{username}} {{emoji}}.', { username, emoji });
        } else {
            const emoji = emojis.get(unfollower.following ? 'broken_heart' : 'wave');
            action = i18n.__('{{username}} unfollowed you {{emoji}}.', { username, emoji });
        }

        let followTimeMsg;
        if (unfollower.followTime > 0) {
            const duration = moment(unfollower.followTime).locale(lang).to(unfollower.unfollowTime, true);
            const time = moment(unfollower.followTime).locale(lang).calendar();
            followTimeMsg = i18n.__('This account followed you for {{duration}} ({{{time}}}).', {duration, time});
        } else {
            followTimeMsg = i18n.__('This account followed you before you signed up to @unfollowninja!');
        }

        return action + '\n' + followTimeMsg;
    });

    if (messages.length === 1) {
        return messages[0];
    }
    const nbUnfollows = (messages.length + nbLeftovers).toString();
    let message = i18n.__('{{nbUnfollows}} twitter users unfollowed you:', { nbUnfollows });
    for (const unfollowerMessage of messages) {
        message += '\n  • ' + unfollowerMessage;
    }
    if (nbLeftovers > 0) {
        message += '\n • ' + i18n.__('and {{nbLeftovers}} more.', { nbLeftovers: nbLeftovers.toString() });
    }

    return message;
}
