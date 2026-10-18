import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from '../observability/metrics.service.ts';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  render(@Res() response: Response): void {
    response.type('text/plain').send(this.metrics.render());
  }
}
