import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Gender, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  GENDERS,
  ProfileView,
  UpdateProfileInput,
  toProfileView,
} from './profile.dto';

const PROFILE_SELECT = {
  id: true,
  name: true,
  mobile: true,
  age: true,
  gender: true,
} satisfies Prisma.PatientSelect;

const NAME_MAX = 80;
const AGE_MIN = 0;
const AGE_MAX = 120;

/**
 * Patient self-service profile. Strictly scoped to the caller's own record
 * (patientId comes from the JWT, never a param). name is the only required
 * field; age/gender are optional. mobile is read-only (it is the login identity).
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(patientId: string): Promise<ProfileView> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
      select: PROFILE_SELECT,
    });
    if (!patient) throw new NotFoundException('patient not found');
    return toProfileView(patient);
  }

  async updateProfile(
    patientId: string,
    input: UpdateProfileInput,
  ): Promise<ProfileView> {
    const data: Prisma.PatientUpdateInput = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new BadRequestException('name cannot be empty');
      }
      if (name.length > NAME_MAX) {
        throw new BadRequestException(`name must be at most ${NAME_MAX} characters`);
      }
      data.name = name;
    }

    if (input.age !== undefined && input.age !== null) {
      if (!Number.isInteger(input.age) || input.age < AGE_MIN || input.age > AGE_MAX) {
        throw new BadRequestException(`age must be an integer between ${AGE_MIN} and ${AGE_MAX}`);
      }
      data.age = input.age;
    } else if (input.age === null) {
      data.age = null;
    }

    if (input.gender !== undefined && input.gender !== null) {
      if (!GENDERS.includes(input.gender)) {
        throw new BadRequestException('gender must be MALE, FEMALE or OTHER');
      }
      data.gender = input.gender as Gender;
    } else if (input.gender === null) {
      data.gender = null;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('no profile fields to update');
    }

    try {
      const updated = await this.prisma.patient.update({
        where: { id: patientId },
        data,
        select: PROFILE_SELECT,
      });
      return toProfileView(updated);
    } catch (err) {
      // P2025 = record not found
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('patient not found');
      }
      throw err;
    }
  }
}
