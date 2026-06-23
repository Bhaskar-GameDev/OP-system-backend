import { createHash, randomInt } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';
import { SMS_SENDER, SmsSender } from './sms.sender';

const OTP_TTL_DEFAULT = 300; // 5 min
const MAX_ATTEMPTS = 5; // wrong guesses before the OTP is burned
const SEND_WINDOW_SEC = 600; // rate-limit window
const MAX_SENDS = 5; // sends allowed per window per mobile

/**
 * Atomic OTP verify. Compares hashed candidate, counts wrong attempts, and
 * burns the OTP once the cap is hit — so a 6-digit code can't be brute-forced
 * inside its validity window.
 *
 * KEYS[1] otp hash   KEYS[2] attempts   ARGV[1] candidate hash   ARGV[2] max
 * returns {'NO_OTP'} | {'OK'} | {'LOCKED'} | {'BAD', attempts}
 */
const VERIFY_LUA = `
local stored = redis.call('GET', KEYS[1])
if not stored then return { 'NO_OTP' } end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return { 'OK' }
end
local attempts = redis.call('INCR', KEYS[2])
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return { 'LOCKED' }
end
return { 'BAD', attempts }
`;

@Injectable()
export class OtpService {
  private commandReady = false;

  constructor(
    private readonly redisService: RedisService,
    private readonly config: ConfigService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  private ttl(): number {
    return this.config.get<number>('OTP_EXPIRY_SECONDS', OTP_TTL_DEFAULT);
  }

  private otpKey(mobile: string): string {
    return `pfos:otp:code:${mobile}`;
  }
  private attemptsKey(mobile: string): string {
    return `pfos:otp:attempts:${mobile}`;
  }
  private sendKey(mobile: string): string {
    return `pfos:otp:sends:${mobile}`;
  }

  private hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }

  /** Generate + send an OTP, enforcing a per-mobile send-rate limit. */
  async requestOtp(mobile: string): Promise<void> {
    const redis = this.redisService.redis;

    // rate-limit sends per window
    const sends = await redis.incr(this.sendKey(mobile));
    if (sends === 1) {
      await redis.expire(this.sendKey(mobile), SEND_WINDOW_SEC);
    }
    if (sends > MAX_SENDS) {
      throw new HttpException(
        'too many OTP requests; try later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const devMode = !this.config.get<string>('MSG91_AUTH_KEY');
    const otp = devMode ? '000000' : String(randomInt(0, 1_000_000)).padStart(6, '0');
    // store only the hash; reset attempts for the new code
    await redis.set(this.otpKey(mobile), this.hashOtp(otp), 'EX', this.ttl());
    await redis.del(this.attemptsKey(mobile));

    await this.sms.sendOtp(mobile, otp);
  }

  /** Verify an OTP. Throws on no/expired OTP, lockout, or wrong code. */
  async verifyOtp(mobile: string, candidate: string): Promise<void> {
    if (!this.commandReady) {
      this.redisService.defineCommand('pfosOtpVerify', {
        numberOfKeys: 2,
        lua: VERIFY_LUA,
      });
      this.commandReady = true;
    }

    const run = (
      this.redisService.redis as unknown as {
        pfosOtpVerify: (
          otpKey: string,
          attemptsKey: string,
          candidateHash: string,
          max: string,
        ) => Promise<string[]>;
      }
    ).pfosOtpVerify.bind(this.redisService.redis);

    const res = await run(
      this.otpKey(mobile),
      this.attemptsKey(mobile),
      this.hashOtp(candidate),
      String(MAX_ATTEMPTS),
    );

    switch (res[0]) {
      case 'OK':
        return;
      case 'NO_OTP':
        throw new UnauthorizedException('no active OTP; request a new one');
      case 'LOCKED':
        throw new UnauthorizedException(
          'too many wrong attempts; OTP invalidated, request a new one',
        );
      default:
        throw new UnauthorizedException('incorrect OTP');
    }
  }
}
