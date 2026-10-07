import { Module } from '@nestjs/common'
import { ReviewsController } from './reviews.controller'
import { ResourcesModule } from '../resources/resources.module'

@Module({ imports: [ResourcesModule], controllers: [ReviewsController] })
export class ReviewsModule {}
