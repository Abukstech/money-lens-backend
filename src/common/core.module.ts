import { Global, Module } from '@nestjs/common';
import { Config } from './config';
import { Db } from './db';
import { Privacy } from './privacy';
@Global()
@Module({ providers: [Config, Db, Privacy], exports: [Config, Db, Privacy] })
export class CoreModule {}
