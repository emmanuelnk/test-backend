import _ from 'lodash'
import { BaseContext } from 'koa'
import jwt from 'jsonwebtoken'
import { getManager, Repository } from 'typeorm'
import { request, summary, responsesAll, tagsAll, body } from 'koa-swagger-decorator'
import { User, userSchema } from '../entity/user'
import { config } from '../utils/config'
import { requiredProperties, isExpired } from '../utils/validate'

@responsesAll({
    200: { description: 'success' },
    400: { description: 'bad request' },
    401: { description: 'unauthorized, missing/wrong jwt token' }
})
@tagsAll(['Auth'])
export default class AuthController {
    @request('post', '/login')
    @summary('Log a user in')
    @body(_.pick(userSchema.properties, ['email', 'password']))
    public static async loginUser(ctx: BaseContext): Promise<void> {
        // validate properties required to create a new user
        const missingProperties = requiredProperties(ctx.request.body, ['email', 'password'])

        if (missingProperties.length) {
            ctx.status = 400
            ctx.body = `missing_fields: ${missingProperties.join(', ')}`
            return
        }

        // Get user from database
        const userRepository: Repository<User> = getManager().getRepository(User)
        let user: User = new User()

        try {
            user = await userRepository.findOneOrFail({ where: { email: ctx.request.body.email } })
        } catch (error) {
            ctx.status = 401
            ctx.body = 'user_not_found'
            return
        }

        // Check if encrypted password match
        if (!(await user.checkIfUnencryptedPasswordIsValid(ctx.request.body.password))) {
            ctx.status = 401
            ctx.body = 'wrong_password'
            return
        }

        // save refresh token
        const refreshToken = jwt.sign({ email: user.email }, config.jwt.refreshTokenSecret, {
            expiresIn: config.jwt.refreshTokenLife,
        })

        await userRepository.save(_.omit({ ...user, refreshToken }, ['createdAt']))

        // Send the jwt token in the response
        ctx.status = 200
        ctx.body = {
            token: jwt.sign({ id: user.id, email: user.email }, config.jwt.accessTokenSecret, {
                expiresIn: config.jwt.accessTokenLife,
            }),
            message: 'login_success',
        }
    }

    @request('get', '/refresh')
    @summary('Get the refresh token')
    public static async refreshToken(ctx: BaseContext): Promise<void> {
        // Get user from database
        const userRepository: Repository<User> = getManager().getRepository(User)
        let user: User = new User()

        const token = ctx?.header?.authorization && ctx.header.authorization.split(' ')[1]
        let decoded: Record<string, any> | string

        try {
            decoded = jwt.verify(token, config.jwt.accessTokenSecret, { ignoreExpiration: true })
        } catch (err) {
            ctx.status = 401
            ctx.body = 'invalid_access_token'
            return
        }

        if (!_.isObject(decoded)) {
            ctx.status = 401
            ctx.body = 'invalid_token'
            return
        }

        // check the token for the user email
        if (!decoded.hasOwnProperty('email')) {
            ctx.status = 401
            ctx.body = 'invalid_token'
            return
        }

        // Send back the old jwt token in the response if still active
        if (!isExpired(decoded.exp)) {
            ctx.status = 200
            ctx.body = {
                token: jwt.sign(decoded, config.jwt.accessTokenSecret),
                message: 'valid_access_token',
            }
            return
        }
        
        try {
            user = await userRepository.findOneOrFail({ where: { email: decoded.email } })
        } catch (error) {
            ctx.status = 401
            ctx.body = 'user_not_found'
            return
        }

        // verify refresh token
        try {
            jwt.verify(user.refreshToken, config.jwt.refreshTokenSecret)
        } catch (err) {
            ctx.status = 401
            ctx.body = 'invalid_refresh_token'
            return
        }

        // Send the jwt token in the response
        ctx.status = 200
        ctx.body = {
            token: jwt.sign({ id: user.id, email: user.email }, config.jwt.accessTokenSecret, {
                expiresIn: config.jwt.accessTokenLife,
            }),
            message: 'refresh_token_success',
        }
    }

    @request('get', '/logout')
    @summary('Log a user out')
    public static async logoutUser(ctx: BaseContext): Promise<void> {
        // possible solutions
        // 1. delete token on client side, delete refresh token on db, wait for access token to expire
        // 2. keep track of invalidated tokens on redis instance and cross-check on each auth request

        // solution 1

        // Get user from database
        const userRepository: Repository<User> = getManager().getRepository(User)
        let user: User = new User()

        try {
            user = await userRepository.findOneOrFail({ where: { email: ctx.state.user.email } })
        } catch (error) {
            ctx.status = 401
            ctx.body = 'user_not_logged_in'
            return
        }

        await userRepository.save(_.omit({ ...user, refreshToken: 'removed' }, ['createdAt']))

        ctx.status = 200
        ctx.body = 'logout_success'
    }
}