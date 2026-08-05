/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8 */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

DROP VIEW IF EXISTS `vw_loadbalancers`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_loadbalancers` AS select `l`.`id` AS `id`,`l`.`name` AS `name`,`l`.`link` AS `link`,`l`.`public` AS `public`,`l`.`status` AS `status`,`l`.`created` AS `created`,`l`.`updated` AS `updated`,`l`.`disallow_hosts` AS `disallow_hosts`,`l`.`disallow_continent` AS `disallow_continent`,cast((select `c`.`value` from `tb_settings` `c` where (`c`.`key` = concat('active_connections_',`l`.`id`)) limit 1) as unsigned) AS `connections`,(select count(0) from `tb_videos_sources` `v` where (`l`.`id` = `v`.`sid`)) AS `playbacks` from `tb_loadbalancers` `l`
;

DROP VIEW IF EXISTS `vw_subtitle_manager`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_subtitle_manager` AS select `s`.`id` AS `id`,`s`.`file_name` AS `file_name`,`s`.`language` AS `language`,`s`.`host` AS `host`,`s`.`created` AS `created`,`s`.`updated` AS `updated`,`u`.`id` AS `uid`,`u`.`name` AS `name` from (`tb_subtitle_manager` `s` join `tb_users` `u` on((`s`.`uid` = `u`.`id`)))
;

DROP VIEW IF EXISTS `vw_users`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_users` AS select `u`.`id` AS `id`,`u`.`name` AS `name`,`u`.`user` AS `user`,`u`.`email` AS `email`,`u`.`status` AS `status`,`u`.`created` AS `created`,`u`.`updated` AS `updated`,`u`.`role` AS `role`,coalesce(`v`.`cnt`,0) AS `videos` from (`tb_users` `u` left join (select `tb_videos`.`uid` AS `uid`,count(0) AS `cnt` from `tb_videos` group by `tb_videos`.`uid`) `v` on((`v`.`uid` = `u`.`id`)))
;

DROP VIEW IF EXISTS `vw_videos`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `vw_videos` AS select `v`.`id` AS `id`,`v`.`title` AS `title`,`v`.`host` AS `host`,`v`.`host_id` AS `host_id`,`v`.`uid` AS `uid`,`v`.`created` AS `created`,`v`.`updated` AS `updated`,`v`.`poster` AS `poster`,`v`.`status` AS `status`,`v`.`views` AS `views`,`v`.`dmca` AS `dmca`,`v`.`slug` AS `slug`,`u`.`name` AS `name`,exists(select 1 from `tb_videos_alternatives` `alt` where (`alt`.`vid` = `v`.`id`)) AS `has_alt`,exists(select 1 from `tb_subtitles` `sub` where (`sub`.`vid` = `v`.`id`)) AS `has_sub` from (`tb_videos` `v` join `tb_users` `u` on((`u`.`id` = `v`.`uid`)))
;

/*!40103 SET TIME_ZONE=IFNULL(@OLD_TIME_ZONE, 'system') */;
/*!40101 SET SQL_MODE=IFNULL(@OLD_SQL_MODE, '') */;
/*!40014 SET FOREIGN_KEY_CHECKS=IFNULL(@OLD_FOREIGN_KEY_CHECKS, 1) */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40111 SET SQL_NOTES=IFNULL(@OLD_SQL_NOTES, 1) */;
