import { IsString, MinLength, MaxLength } from 'class-validator'

export class LoginDto {
  @IsString()
  @MinLength(1, { message: '请输入用户名' })
  @MaxLength(64)
  username!: string

  @IsString()
  @MinLength(1, { message: '请输入密码' })
  @MaxLength(200)
  password!: string
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1, { message: '请输入当前密码' })
  currentPassword!: string

  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  @MaxLength(200)
  newPassword!: string
}
