import type { RoleCode } from '@shared/api.interface';

export interface SeedTeacher {
  username: string;
  name: string;
  nameEn: string;
  roles: RoleCode[];
  passwordHash: string;
}

export const SEED_TEACHERS: SeedTeacher[] = [
  {
    username: 'qlsadmin',
    name: '园长/平台管理员',
    nameEn: 'Principal / Platform Admin',
    roles: ['principal'],
    passwordHash:
      'scrypt$16384$8$1$Z/v9KX7My//PcJ6IPpql1Q==$+i7j4tNyVfPALHKp47KJLEQ8LnkOBr4gCgv0uFJQ2D4=',
  },
  {
    username: 'qlsdirector',
    name: '教学主任/教研主管',
    nameEn: 'Curriculum Director',
    roles: ['curriculum_director'],
    passwordHash:
      'scrypt$16384$8$1$V2XsxCINOQm1oPrbPMZkTg==$uAPE9ZT9g1iX+dmPHkAdS1vvlyPUsFNod93br1bhZVw=',
  },
  {
    username: 'prek-head01',
    name: 'Pre-K主教01',
    nameEn: 'Pre-K Head Teacher 01',
    roles: ['prek_head'],
    passwordHash:
      'scrypt$16384$8$1$nP8sYbRC7LHmQH/l/ER1wg==$XvJ4EPrBugIz2pkXC6UusBEVVO424FRNS4rfZ748SZs=',
  },
  {
    username: 'prek-head02',
    name: 'Pre-K主教02',
    nameEn: 'Pre-K Head Teacher 02',
    roles: ['prek_head'],
    passwordHash:
      'scrypt$16384$8$1$ZPGKMObAGbebbmJKNcB10w==$h85t5eBt5hePKbaIxmWsoAaaRz3vn9Yj4EbUXvUcfvs=',
  },
  {
    username: 'prek-head03',
    name: 'Pre-K主教03',
    nameEn: 'Pre-K Head Teacher 03',
    roles: ['prek_head'],
    passwordHash:
      'scrypt$16384$8$1$QHsKO1hFnL91jmSOhbivLA==$8MEZCxhi7cepZPzPMFO9InieTWrwe5Fo2JubuysNhxM=',
  },
  {
    username: 'prek-teacher01',
    name: 'Pre-K教师01',
    nameEn: 'Pre-K Teacher 01',
    roles: ['prek_assistant'],
    passwordHash:
      'scrypt$16384$8$1$rURKJkoPJ5ctECVNRtwQog==$nuf9pLP/QoCk725LI4XwyLQCV3AI2YcssirXO/n9IYQ=',
  },
  {
    username: 'prek-teacher02',
    name: 'Pre-K教师02',
    nameEn: 'Pre-K Teacher 02',
    roles: ['prek_assistant'],
    passwordHash:
      'scrypt$16384$8$1$iBj3NTdPvmIobYRxu+r1fA==$o5C5VAm3HyN8beAZ3b+z6lFat8B7QwDv2tRj42jKJ8k=',
  },
  {
    username: 'prek-teacher03',
    name: 'Pre-K教师03',
    nameEn: 'Pre-K Teacher 03',
    roles: ['prek_assistant'],
    passwordHash:
      'scrypt$16384$8$1$r3Ka192TCnXniPl2fkWvYA==$mxg7Dfnehl0aYdP/50bRbtd1PcCAIfP4cmN1iFizWAA=',
  },
  {
    username: 'prek-teacher04',
    name: 'Pre-K教师04',
    nameEn: 'Pre-K Teacher 04',
    roles: ['prek_assistant'],
    passwordHash:
      'scrypt$16384$8$1$q4QSguzDn1zxGTe6OYviLg==$/nTCW4CKdMW0P5C2/2O125+nxEhfYiwdj0/pzBwyjAY=',
  },
  {
    username: 'k-head01',
    name: 'K主教01',
    nameEn: 'K Head Teacher 01',
    roles: ['k_head'],
    passwordHash:
      'scrypt$16384$8$1$wW1oqNFYtr7w2UXlvg/6qw==$AqMfw4rw/hBGUf42dMqgNslMY9TNiQDyj+sSTnFCQvo=',
  },
  {
    username: 'k-head02',
    name: 'K主教02',
    nameEn: 'K Head Teacher 02',
    roles: ['k_head'],
    passwordHash:
      'scrypt$16384$8$1$A42QX2vrlJw6wXOUcmxebQ==$seaTx3qD3PNSH33i8pvaReRAF7P5NVPSnYZ3yJA6zjM=',
  },
  {
    username: 'k-head03',
    name: 'K主教03',
    nameEn: 'K Head Teacher 03',
    roles: ['k_head'],
    passwordHash:
      'scrypt$16384$8$1$6Lj1akosnvvJDdEH6vRCig==$SRjt7tzxPdNiDxsuolzFfLzG0PwFJWEQBbjcSyNWMcs=',
  },
  {
    username: 'k-teacher01',
    name: 'K教师01',
    nameEn: 'K Teacher 01',
    roles: ['k_assistant'],
    passwordHash:
      'scrypt$16384$8$1$UZcEmJIpNeVb/vXeVBr5MQ==$YgwEfQXqvjz/PA4DAwsrONGQEQ43qTjJL4F39FfX7pM=',
  },
  {
    username: 'k-teacher02',
    name: 'K教师02',
    nameEn: 'K Teacher 02',
    roles: ['k_assistant'],
    passwordHash:
      'scrypt$16384$8$1$2a3XniMBHV2PH7hSBAzUrA==$e2FfR4OOTHG90R0UbX8rCxc6pm37OJrOZ6DS8yJjAjs=',
  },
  {
    username: 'k-teacher03',
    name: 'K教师03',
    nameEn: 'K Teacher 03',
    roles: ['k_assistant'],
    passwordHash:
      'scrypt$16384$8$1$0MJX1hgFgrx12YOGXkqvgg==$IdM09viFabeivO4YolBBZC3n2Uk1PyzvAdgZfYiRhEU=',
  },
  {
    username: 'k-teacher04',
    name: 'K教师04',
    nameEn: 'K Teacher 04',
    roles: ['k_assistant'],
    passwordHash:
      'scrypt$16384$8$1$820vx1QTBhEHARbYcRHxSA==$RPkqxMPBS7NniigekkHTkARPVhO6M6liTH0dAmbITK8=',
  },
  {
    username: 'pe-teacher01',
    name: '体能教师01',
    nameEn: 'PE Teacher 01',
    roles: ['pe_specialist'],
    passwordHash:
      'scrypt$16384$8$1$fSMwo2p9PgpydIc2BKCNSA==$gUuIxMr8t1YUG5lZgtsxq3SenCSpDyin7WsefplF+8U=',
  },
  {
    username: 'pe-teacher02',
    name: '体能教师02',
    nameEn: 'PE Teacher 02',
    roles: ['pe_specialist'],
    passwordHash:
      'scrypt$16384$8$1$BJ83hByoobLXVKyft4MQZA==$mi1UxUFCFhnM4y972laV0aTbMyedIgkcVaWYHItvaIE=',
  },
  {
    username: 'pe-teacher03',
    name: '体能教师03',
    nameEn: 'PE Teacher 03',
    roles: ['pe_specialist'],
    passwordHash:
      'scrypt$16384$8$1$wRTUz6aLJt7xef/N7UShpQ==$sFPHYfspir2uMvEFB/Rl/Pe4ubpf+Rkc3fTAz10JR2Y=',
  },
  {
    username: 'pe-teacher04',
    name: '体能教师04',
    nameEn: 'PE Teacher 04',
    roles: ['pe_specialist'],
    passwordHash:
      'scrypt$16384$8$1$kfU373gqRO4tdxMIy3QWJA==$5rGuRpXEWeCqk88fmSPasEPmvGQO4hCg+3RnnOT5uYo=',
  },
];
