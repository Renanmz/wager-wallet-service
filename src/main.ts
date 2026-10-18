import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.ts';
import { ApplicationErrorFilter } from './http/application-error.filter.ts';

const app = await NestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
}));
app.useGlobalFilters(new ApplicationErrorFilter());
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
